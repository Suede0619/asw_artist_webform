import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { verifiedPostgresUrl } from '../server/store.mjs';

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error('Set DATABASE_URL_UNPOOLED before applying the Postgres schema.');
if (new URL(connectionString).hostname.split('.')[0].endsWith('-pooler')) {
  throw new Error('Use the direct DATABASE_URL_UNPOOLED connection for schema migrations.');
}
const client = new pg.Client({
  connectionString: verifiedPostgresUrl(connectionString), connectionTimeoutMillis: 10000, enableChannelBinding: true,
});
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(419204, 1)');
  await client.query('CREATE TABLE IF NOT EXISTS asw_schema_migrations (version integer PRIMARY KEY)');
  if (!(await client.query('SELECT 1 FROM asw_schema_migrations WHERE version=1')).rowCount) {
    await client.query(await readFile(new URL('../server/schema/001-intake.sql', import.meta.url), 'utf8'));
    await client.query('INSERT INTO asw_schema_migrations(version) VALUES(1)');
  }
  await client.query('COMMIT');
  console.log('Postgres intake schema version 1 ready.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Postgres schema migration failed.', error.code || error.name);
  process.exitCode = 1;
} finally {
  await client.end();
}
