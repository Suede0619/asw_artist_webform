import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function localKey(directory) {
  const path = join(directory, 'mail-queue.key');
  try {
    writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return readFileSync(path, 'utf8').trim();
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const mailDisabled = env.MAIL_DISABLED === '1';
  const port = Number(env.PORT || 4080);
  const host = env.HOST || '127.0.0.1';
  let publicUrl;
  try {
    publicUrl = new URL(env.PUBLIC_URL || ('http://127.0.0.1:' + port));
  } catch {
    throw new Error('PUBLIC_URL must be a valid app origin.');
  }
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.pathname !== '/' ||
      publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_URL must be the app origin, with no path, query, hash, or credentials.');
  }
  const dataDir = resolve(env.DATA_DIR || 'data');
  const trustProxy = Number(env.TRUST_PROXY_HOPS || 0);
  const reviewerPassword = env.REVIEWER_PASSWORD || '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 3) {
    throw new Error('Configure a valid PORT and TRUST_PROXY_HOPS (0–3).');
  }
  if (production && (publicUrl.protocol !== 'https:' || reviewerPassword.length < 24 || !env.MAIL_QUEUE_KEY || !env.CALLBACK_OWNER)) {
    throw new Error('Production requires HTTPS PUBLIC_URL, REVIEWER_PASSWORD (24+ characters), MAIL_QUEUE_KEY and CALLBACK_OWNER.');
  }
  if (production && !mailDisabled && (!env.SMTP_URL || !env.MAIL_FROM || !env.REPLY_TO)) {
    throw new Error('Production email requires SMTP_URL, MAIL_FROM and REPLY_TO. Set MAIL_DISABLED=1 for intake with private recovery links.');
  }
  if (env.SMTP_URL) {
    try {
      const smtp = new URL(env.SMTP_URL);
      if (!['smtp:', 'smtps:'].includes(smtp.protocol) || !smtp.hostname || smtp.port === '0') {
        throw new Error('Invalid SMTP settings.');
      }
      decodeURIComponent(smtp.username);
      decodeURIComponent(smtp.password);
    } catch {
      throw new Error('SMTP_URL must be a valid smtp:// or smtps:// server URL.');
    }
  }
  const databaseUrl = env.DATABASE_URL;
  const storage = {
    bucket: env.NEON_MEDIA_BUCKET || 'uploads',
    endpoint: env.AWS_ENDPOINT_URL_S3,
    region: env.AWS_REGION,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  };
  if (databaseUrl && !Object.values(storage).every(Boolean)) {
    throw new Error('Neon requires the object storage endpoint, region, and access credentials.');
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const hexKey = env.MAIL_QUEUE_KEY || localKey(dataDir);
  if (!/^[a-f0-9]{64}$/i.test(hexKey)) throw new Error('MAIL_QUEUE_KEY must be 64 hexadecimal characters.');
  return {
    databaseUrl, objectStorage: databaseUrl ? storage : null,
    catalogDir: env.CATALOG_DIR ? resolve(env.CATALOG_DIR) : null,
    itineraryKey: env.ITINERARY_OPENAI_API_KEY || '',
    itineraryModel: env.ITINERARY_OPENAI_MODEL || 'gpt-4o-mini',
    production, port, host, publicUrl: publicUrl.origin, secureCookie: publicUrl.protocol === 'https:',
    mailEnabled: !mailDisabled,
    trustProxy, dataDir, smtpUrl: env.SMTP_URL || '', mailFrom: env.MAIL_FROM || 'ArtSouthwest <preview@example.test>',
    replyTo: env.REPLY_TO || '', mailKey: Buffer.from(hexKey, 'hex'), reviewerPassword,
    reviewerId: env.REVIEWER_ID || 'editor', callbackOwner: env.CALLBACK_OWNER || 'taos-city-lead',
  };
}
