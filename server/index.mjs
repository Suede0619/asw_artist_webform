import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';

process.umask(0o077);
const config = loadConfig();
const { app, db, outbox } = createApp(config);
if (config.databaseUrl) {
  try {
    const version = await db.prepare('SELECT version FROM asw_schema_migrations WHERE version=1').get();
    if (!version) throw new Error('The Postgres intake schema is missing.');
  } catch (error) {
    await db.close();
    console.error('Postgres startup check failed. Run npm run migrate:postgres and check the database connection.', error.code || error.name);
    process.exit(1);
  }
}
const server = app.listen(config.port, config.host, () => {
  console.log('ArtSouthwest intake listening on ' + config.publicUrl);
  if (config.databaseUrl) console.log('Storage: Neon Postgres and private Object Storage.');
  if (!config.smtpUrl) console.log('Preview email is written to the private data directory.');
});
server.requestTimeout = 90_000;
server.headersTimeout = 20_000;
const interval = setInterval(() => {
  outbox.pump().catch(() => console.error('The transactional email queue needs attention.'));
}, 2000);
interval.unref();
function stop() {
  clearInterval(interval);
  server.close(async () => {
    await outbox.drain()?.catch(() => null);
    await db.close();
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
