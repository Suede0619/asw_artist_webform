import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { transaction } from './database.mjs';
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

function newLink(db, config, appId, now) {
  const token = secret();
  db.prepare('INSERT INTO resume_links(hash,app_id,expires_at) VALUES(?,?,?)')
    .run(digest(token), appId, now + DAY);
  return config.publicUrl + '/resume#' + token;
}

function draftMessage(db, config, { id, email }, now, note) {
  const link = newLink(db, config, id, now);
  const opening = note ? 'Our editorial team has requested an update to your submission.\n\n' + note :
    'Use the private link below to start or resume your Southwest Arts artist submission.';
  return {
    to: email,
    subject: note ? 'A note on your Southwest Arts submission' : 'Your Southwest Arts submission link',
    text: opening + '\n\n' + link + '\n\nThis link expires in 24 hours and works once. You can request a new link on the invitation page.\n\nSouthwest Arts',
  };
}

// Call queue functions within the transaction that records the associated state change.
export function queueDraftLink(db, config, application, now, note = '') {
  const id = randomUUID();
  const message = draftMessage(db, config, application, now, note);
  db.prepare(`INSERT INTO outbox(id,event_key,app_id,kind,payload,state,next_at,created_at)
    VALUES(?,?,?,?,?,'pending',?,?)`).run(id, id, application.id, note ? 'changes' : 'resume',
    seal(config.mailKey, message), now, now);
}

export function queueReceipt(db, config, { id, email, revision }, now) {
  const text = 'Thank you for sharing your work. We’ll review your submission and email you with the next step.\n\n' +
    'Your reference is ' + id.slice(0, 8).toUpperCase() +
    '. If a work sells, or if you need to make a correction, return to ' + config.publicUrl +
    '/start for a private link.\n\nSouthwest Arts';
  const payload = seal(config.mailKey, { to: email, subject: 'We received your Southwest Arts submission', text });
  db.prepare(`INSERT OR IGNORE INTO outbox(id,event_key,app_id,kind,payload,state,next_at,created_at)
    VALUES(?,?,?,'receipt',?,'pending',?,?)`).run(randomUUID(), 'receipt:' + id + ':' + revision, id, payload, now, now);
}

export function retryMail(db, config, id) {
  return transaction(db, () => {
    const row = db.prepare(`SELECT * FROM outbox WHERE id=? AND state='failed'`).get(id);
    if (!row) return false;
    const now = Date.now();
    let payload = row.payload;
    if (row.kind !== 'receipt') {
      const application = db.prepare('SELECT id,email,review_note FROM applications WHERE id=?').get(row.app_id);
      if (!application) return false;
      payload = seal(config.mailKey, draftMessage(db, config, application, now, row.kind === 'changes' ? application.review_note : ''));
    }
    return db.prepare(`UPDATE outbox SET state='pending',payload=?,attempts=0,next_at=?,last_error=NULL
      WHERE id=? AND state='failed'`).run(payload, now, id).changes === 1;
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
    const row = transaction(db, () => {
      db.prepare(`UPDATE outbox SET state='failed',last_error='Delivery interrupted'
        WHERE state='sending' AND next_at<=? AND attempts>=?`).run(now, MAX_ATTEMPTS);
      const item = db.prepare(`SELECT * FROM outbox WHERE state IN ('pending','sending')
        AND next_at<=? AND attempts<? ORDER BY created_at,id LIMIT 1`).get(now, MAX_ATTEMPTS);
      if (!item) return null;
      db.prepare(`UPDATE outbox SET state='sending',attempts=attempts+1,next_at=? WHERE id=?`)
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
      db.prepare(`UPDATE outbox SET state='sent',payload=NULL,sent_at=?,last_error=NULL WHERE id=?`)
        .run(Date.now(), row.id);
    } catch {
      const attempts = row.attempts + 1;
      const nextAt = Date.now() + 60_000 * (2 ** (attempts - 1));
      db.prepare(`UPDATE outbox SET state=?,next_at=?,last_error='Check transactional email settings' WHERE id=?`)
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
