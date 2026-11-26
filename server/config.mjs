import { z } from 'zod';
import { httpsUrl } from '../shared/editorial.mjs';
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

function editorialSettings(env) {
  if (env.EDITORIAL_ENABLED !== '1') return null;
  const sources = z.array(z.object({
    url:z.string().refine(httpsUrl), city:z.enum(['taos','santa-fe']), venue:z.string().max(140).optional(),
    kind:z.enum(['event','exhibition']).optional(), timeZone:z.literal('America/Denver').optional(),
    adapter:z.enum(['harwood-exhibitions','site-santa-fe']).optional(),
    imageHosts:z.array(z.string().regex(/^[A-Za-z0-9.-]+$/)).max(8).optional(),
    detailPath:z.string().regex(/^\/[A-Za-z0-9/_-]+\/$/).optional(),
  })).max(15).parse(JSON.parse(env.EDITORIAL_SOURCES || readFileSync(new URL('./editorial/sources.json',import.meta.url),'utf8')));
  const origin=env.CATALOG_ORIGIN || (env.NODE_ENV==='production' ? 'https://artsouthwest.com' : env.PUBLIC_URL || 'http://127.0.0.1:'+(env.PORT||4080));
  const local=env.NODE_ENV!=='production' && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]+)?$/.test(origin);
  if ((!local && !httpsUrl(origin)) || new URL(origin).origin!==origin) throw new Error('Configure the HTTPS editorial catalog origin.');
  const signup=env.MAILCHIMP_SIGNUP_URL || '';
  if (signup && !httpsUrl(signup)) throw new Error('Use an HTTPS Mailchimp signup link.');
  const mailchimp={ key:env.MAILCHIMP_API_KEY || '', audience:env.MAILCHIMP_AUDIENCE_ID || '',
    replyTo:env.MAILCHIMP_SENDER_EMAIL || '', send:env.EDITORIAL_MAIL_SEND==='1' };
  if (mailchimp.send && (local || !mailchimp.key || !mailchimp.audience || !mailchimp.replyTo || !env.EDITORIAL_POSTAL_ADDRESS)) {
    throw new Error('Connect the Mailchimp audience, sender and postal address before enabling newsletter sends.');
  }
  const sponsorPrice=Number(env.EDITORIAL_SPONSOR_PRICE_CENTS || 0);
  if (!Number.isSafeInteger(sponsorPrice) || sponsorPrice<0 || sponsorPrice>10_000_00) throw new Error('Invalid USD sponsorship price.');
  const stripe={ key:env.EDITORIAL_STRIPE_SECRET_KEY || '', webhook:env.EDITORIAL_STRIPE_WEBHOOK_SECRET || '' };
  return { origin,sources,signup,mailchimp,stripe,sponsorPrice,logo:env.EDITORIAL_LOGO_URL || origin+'/ArtSouthwest-wordmark.png',
    address:env.EDITORIAL_POSTAL_ADDRESS || '', modelKey:env.EDITORIAL_OPENAI_API_KEY || '',
    model:env.EDITORIAL_OPENAI_MODEL || 'gpt-4o-mini', jobs:env.EDITORIAL_JOBS==='1' };
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
  const reviewerTeamAccess = env.REVIEWER_TEAM_ACCESS || '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 3) {
    throw new Error('Configure a valid PORT and TRUST_PROXY_HOPS (0–3).');
  }
  if (production && (publicUrl.protocol !== 'https:' || reviewerPassword.length < 24 || !env.MAIL_QUEUE_KEY || !env.CALLBACK_OWNER)) {
    throw new Error('Production requires HTTPS PUBLIC_URL, REVIEWER_PASSWORD (24+ characters), MAIL_QUEUE_KEY and CALLBACK_OWNER.');
  }
  if (reviewerTeamAccess && !/^[\w-]{43}:[^\r\n]{1,400}$/.test(reviewerTeamAccess)) {
    throw new Error('REVIEWER_TEAM_ACCESS must contain a 32-byte base64url token, a colon and a password.');
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
    editorial: editorialSettings(env),
    databaseUrl, objectStorage: databaseUrl ? storage : null,
    catalogDir: env.CATALOG_DIR ? resolve(env.CATALOG_DIR) : null,
    itineraryKey: env.ITINERARY_OPENAI_API_KEY || '',
    itineraryModel: env.ITINERARY_OPENAI_MODEL || 'gpt-4o-mini',
    production, port, host, publicUrl: publicUrl.origin, secureCookie: publicUrl.protocol === 'https:',
    mailEnabled: !mailDisabled,
    trustProxy, dataDir, smtpUrl: env.SMTP_URL || '', mailFrom: env.MAIL_FROM || 'ArtSouthwest <preview@example.test>',
    replyTo: env.REPLY_TO || '', mailKey: Buffer.from(hexKey, 'hex'), reviewerPassword, reviewerTeamAccess,
    reviewerId: env.REVIEWER_ID || 'editor', callbackOwner: env.CALLBACK_OWNER || 'taos-city-lead',
  };
}
