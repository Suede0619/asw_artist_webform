import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { cleanEmail, SUBMISSION_RECEIPT } from '../shared/intake.mjs';
import { DAY, digest, secret } from './security.mjs';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 5 * 60_000;

function seal(key, message) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
}

function unseal(key, payload) {
  const bytes = Buffer.from(payload, 'base64');
  const decoder = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decoder.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decoder.update(bytes.subarray(28)), decoder.final()]).toString('utf8'));
}

async function newLink(db, config, appId, now, recipient) {
  const token = secret();
  await db.prepare('INSERT INTO resume_links(hash,app_id,expires_at,recipient) VALUES(?,?,?,?)')
    .run(digest(token), appId, now + DAY, recipient);
  return (config.artistPublicUrl || config.publicUrl) + '/resume#' + token;
}

export function draftLinkRecipient({ email, draft }) {
  return email || cleanEmail.safeParse(JSON.parse(draft).profile.email).data;
}

async function draftMessage(db, config, application, now, note) {
  const recipient = draftLinkRecipient(application);
  const link = await newLink(db, config, application.id, now, application.email ? null : recipient);
  const opening = note ? 'Our editorial team has requested an update to your submission.\n\n' + note :
    'Use the private link below to start or resume your ArtSouthwest artist submission.';
  return {
    to: recipient,
    subject: note ? 'A note on your ArtSouthwest submission' : 'Your ArtSouthwest submission link',
    text: opening + '\n\n' + link + '\n\nThis link expires in 24 hours and works once. Request a new link from your submission if needed.\n\nArtSouthwest',
  };
}

// Call queue functions within the transaction that records the associated state change.
export async function queueDraftLink(db, config, application, now, note = '') {
  const id = randomUUID();
  const message = await draftMessage(db, config, application, now, note);
  await db.prepare(`INSERT INTO outbox(id,event_key,app_id,kind,payload,state,next_at,created_at)
    VALUES(?,?,?,?,?,'pending',?,?)`).run(id, id, application.id, note ? 'changes' : 'resume',
    seal(config.mailKey, message), now, now);
}

export async function queueReceipt(db, config, { id, email, draft, revision }, now) {
  const contact = cleanEmail.parse(JSON.parse(draft).profile.email);
  const access = contact === email
    ? 'request a private link at ' + (config.artistPublicUrl || config.publicUrl) + '/resume.'
    : 'open your submission again in the browser you used to submit.';
  const text = SUBMISSION_RECEIPT + '\n\n' +
    'Your reference is ' + id.slice(0, 8).toUpperCase() +
    '. If a work sells or you need to make a correction, ' + access + '\n\nArtSouthwest';
  const payload = seal(config.mailKey, { to: contact, subject: 'We received your ArtSouthwest submission', text });
  await db.prepare(`INSERT INTO outbox(id,event_key,app_id,kind,payload,state,next_at,created_at)
    VALUES(?,?,?,'receipt',?,'pending',?,?) ON CONFLICT(event_key) DO NOTHING`).run(randomUUID(), 'receipt:' + id + ':' + revision, id, payload, now, now);
}

export function retryMail(db, config, id) {
  return db.transaction(async () => {
    const row = await db.prepare(`SELECT * FROM outbox WHERE id=? AND state='failed'`).get(id);
    if (!row) return false;
    const now = Date.now();
    let payload = row.payload;
    if (row.kind !== 'receipt') {
      const application = await db.prepare('SELECT id,email,draft,review_note FROM applications WHERE id=?').get(row.app_id);
      if (!application || draftLinkRecipient(application) !== unseal(config.mailKey, row.payload).to) return false;
      payload = seal(config.mailKey, await draftMessage(db, config, application, now, row.kind === 'changes' ? application.review_note : ''));
    }
    return (await db.prepare(`UPDATE outbox SET state='pending',payload=?,attempts=0,next_at=?,last_error=NULL
      WHERE id=? AND state='failed'`).run(payload, now, id)).changes === 1;
  });
}

function delivery(config) {
  if (!config.smtpUrl) {
    return async (message, id) => {
      const directory = join(config.dataDir, 'dev-mail');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = join(directory, id + '.json');
      await writeFile(target + '.tmp', JSON.stringify(message, null, 2) + '\n', { mode: 0o600 });
      await rename(target + '.tmp', target);
    };
  }
  const parsed = new URL(config.smtpUrl);
  const transport = nodemailer.createTransport({
    host: parsed.hostname, port: Number(parsed.port || (parsed.protocol === 'smtps:' ? 465 : 587)),
    secure: parsed.protocol === 'smtps:', requireTLS: parsed.protocol !== 'smtps:',
    auth: parsed.username ? { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) } : undefined,
    connectionTimeout: 15000, greetingTimeout: 12000, socketTimeout: 30000,
  });
  return async (message) => {
    const info = await transport.sendMail(message);
    if (!info.accepted?.length) throw new Error('SMTP did not accept a recipient.');
  };
}

export function createOutbox(db, config, send = delivery(config)) {
  let active = null;

  async function deliverOne() {
    const now = Date.now();
    const row = await db.transaction(async () => {
      await db.prepare(`UPDATE outbox SET state='failed',last_error='Delivery interrupted'
        WHERE state='sending' AND next_at<=? AND attempts>=?`).run(now, MAX_ATTEMPTS);
      const item = await db.prepare(`SELECT * FROM outbox WHERE state IN ('pending','sending')
        AND next_at<=? AND attempts<? ORDER BY created_at,id LIMIT 1`).get(now, MAX_ATTEMPTS);
      if (!item) return null;
      await db.prepare(`UPDATE outbox SET state='sending',attempts=attempts+1,next_at=? WHERE id=?`)
        .run(now + LEASE_MS, item.id);
      return item;
    });
    if (!row) return false;
    try {
      const message = unseal(config.mailKey, row.payload);
      const host = new URL(config.publicUrl).hostname;
      await send({
        ...message, from: config.mailFrom, replyTo: config.replyTo || undefined,
        messageId: '<' + row.id + '@' + host + '>',
        disableFileAccess: true, disableUrlAccess: true,
      }, row.id);
      await db.prepare(`UPDATE outbox SET state='sent',payload=NULL,sent_at=?,last_error=NULL WHERE id=?`)
        .run(Date.now(), row.id);
    } catch {
      const attempts = row.attempts + 1;
      const nextAt = Date.now() + 60_000 * (2 ** (attempts - 1));
      await db.prepare(`UPDATE outbox SET state=?,next_at=?,last_error='Check transactional email settings' WHERE id=?`)
        .run(attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', nextAt, row.id);
    }
    return true;
  }

  function pump() {
    if (!active) {
      active = (async () => {
        for (let i = 0; i < 5; i++) if (!await deliverOne()) break;
      })().finally(() => { active = null; });
    }
    return active;
  }
  return { pump, drain: () => active };
}
