import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import { createApp } from '../server/app.mjs';
import { loadConfig } from '../server/config.mjs';

process.umask(0o077);
const livePort = Number(process.env.PORT || 4098);
const reviewPort = Number(process.env.REVIEW_PORT || 4099);
const host = '127.0.0.1';
const dataDir = resolve(process.env.DATA_DIR || 'data/callback-intake');
const config = loadConfig({
  ...process.env, HOST: host, PORT: String(livePort), TRUST_PROXY_HOPS: '1', DATA_DIR: dataDir,
  REVIEWER_PASSWORD: process.env.REVIEWER_PASSWORD || readFileSync(resolve(dataDir, 'reviewer-password'), 'utf8').trim(),
});
if (!config.databaseUrl && process.env.ALLOW_LOCAL_SQLITE !== '1') throw new Error('The tunnel origin requires Neon.');
if (config.reviewerPassword.length < 24) throw new Error('Configure the private reviewer password.');
config.mailEnabled = Boolean(config.smtpUrl);
const reviewOrigin = 'http://' + host + ':' + reviewPort;
const { app, db, outbox } = createApp(config);
if (config.databaseUrl) {
  const version = await db.prepare('SELECT version FROM asw_schema_migrations WHERE version=1').get();
  if (!version) throw new Error('Run the Neon schema migration first.');
}
const staff = createApp({ ...config, publicUrl: reviewOrigin, secureCookie: false, trustProxy: 0 });
const publicApp = express().disable('x-powered-by');
publicApp.use(['/review', '/api/review'], (_req, res) => res.sendStatus(404));
publicApp.use(app);
const listeners = [];
function listen(application, port) {
  return new Promise((ready, reject) => {
    const server = application.listen(port, host, () => {
      listeners.push(server);
      ready();
    });
    server.once('error', reject);
    server.requestTimeout = 90_000;
    server.headersTimeout = 20_000;
  });
}
try {
  await listen(staff.app, reviewPort);
  await listen(publicApp, livePort);
} catch (error) {
  for (const listener of listeners) listener.close();
  await Promise.all([db.close(), staff.db.close()]);
  console.error('Origin listener failed.', error.code || error.name);
  process.exit(1);
}
console.log('Public intake origin ready with ' + (db.postgres ? 'Neon Postgres and Object Storage' : 'SQLite') + '.');
console.log('Staff review at ' + reviewOrigin + '/review');
const queue = config.mailEnabled ? setInterval(() => {
  outbox.pump().catch(() => console.error('The transactional email queue needs attention.'));
}, 2000) : null;
queue?.unref();
async function stop() {
  if (queue) clearInterval(queue);
  await Promise.all(listeners.map(server => new Promise(done => server.close(done))));
  await outbox.drain()?.catch(() => null);
  await Promise.all([db.close(), staff.db.close()]);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
