import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export function secret() {
  return randomBytes(32).toString('base64url');
}

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sameSecret(a, b) {
  return timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));
}

export function cookie(req, name) {
  for (const pair of (req.headers.cookie || '').split(';')) {
    const [key, value] = pair.trim().split('=', 2);
    if (key === name && /^[\w-]{43}$/.test(value || '')) return value;
  }
  return '';
}

export function rateLimit(db, key, scope, value, limit, period) {
  const bucket = createHmac('sha256', key).update(scope + ':' + value).digest('hex');
  const window = Math.floor(Date.now() / period) * period;
  return db.transaction(async () => {
    const r = await db.prepare('SELECT count FROM rate_buckets WHERE bucket = ? AND "window" = ?').get(bucket, window);
    if (r?.count >= limit) return false;
    await db.prepare(`INSERT INTO rate_buckets(bucket,"window",count) VALUES(?,?,1)
      ON CONFLICT(bucket,"window") DO UPDATE SET count = rate_buckets.count + 1`).run(bucket, window);
    return true;
  });
}
