import { createApp } from './app.mjs';
import { loadConfig } from './config.mjs';

process.umask(0o077);
const config = loadConfig();
const { app, db, outbox } = createApp(config);
const server = app.listen(config.port, config.host, () => {
  console.log('Southwest Arts intake listening on ' + config.publicUrl);
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
    db.close();
  });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
