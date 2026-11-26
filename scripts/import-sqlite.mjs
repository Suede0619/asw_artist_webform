import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../server/config.mjs';
import { mediaPath } from '../server/media.mjs';
import { createObjectMedia } from '../server/object-media.mjs';
import { createStore } from '../server/store.mjs';

const [directory, mode] = process.argv.slice(2);
if (!directory || (mode && mode !== '--apply')) {
  console.error('Usage: npm run import:sqlite -- <private backup directory> [--apply]');
  process.exit(1);
}
const tables = {
  applications: ['id'], versions: ['app_id', 'revision'], assets: ['id'],
  resume_links: ['hash'], artist_sessions: ['hash'], callbacks: ['id'], audit: ['id'],
  reports: ['app_id', 'request_key'], publications: ['app_id'], public_assets: ['app_id', 'asset_id'],
  outbox: ['id'], rate_buckets: ['bucket', 'window'], landing_sessions: ['id'],
};
const quote = (identifier) => '"' + identifier + '"';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
process.umask(0o077);

async function run() {
  const source = resolve(directory);
  const sqlite = new DatabaseSync(join(source, 'intake.sqlite'), { readOnly: true });
  const snapshot = {};
  try {
    if (sqlite.prepare('PRAGMA user_version').get().user_version !== 2 ||
        sqlite.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
        sqlite.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error('Use an intact version 2 SQLite backup.');
    }
    for (const table of Object.keys(tables)) snapshot[table] = sqlite.prepare('SELECT * FROM ' + table).all();
  } finally {
    sqlite.close();
  }

  async function checkedImage(asset, original) {
    if (!uuid.test(asset.id) || !['jpeg', 'png', 'webp'].includes(asset.format)) {
      throw new Error('Unexpected image record in the backup.');
    }
    const bytes = await readFile(mediaPath(source, asset.id, original));
    if (original ? bytes.length !== asset.bytes : bytes[0] !== 255 || bytes[1] !== 216) {
      throw new Error('An image in the backup is incomplete.');
    }
    return bytes;
  }
  for (const asset of snapshot.assets) {
    await checkedImage(asset, true);
    await checkedImage(asset, false);
  }
  console.log('Verified source:', JSON.stringify(Object.fromEntries(
    Object.entries(snapshot).map(([table, rows]) => [table, rows.length])
  )));
  if (!mode) return;

  const config = loadConfig();
  if (!config.databaseUrl || !config.objectStorage) throw new Error('Configure Neon Postgres and private Object Storage.');
  const expectedMailKey = await readFile(join(source, 'mail-queue.key'), 'utf8').catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  if (snapshot.outbox.some(row => row.payload) &&
      expectedMailKey.trim() !== config.mailKey.toString('hex')) {
    throw new Error('Use the backup’s mail queue key to preserve encrypted mail.');
  }

  const db = createStore(config);
  const objectStore = createObjectMedia(config.objectStorage);
  try {
    await db.transaction(async () => {
      // Run with both public writers stopped. The Neon advisory lock also excludes app transactions.
      for (const [table, ids] of Object.entries(tables)) {
        if (!snapshot[table].length) continue;
        for (const row of snapshot[table]) {
          const columns = Object.keys(row);
          const identity = ids.map(id => quote(id) + '=?').join(' AND ');
          const keys = ids.map(id => row[id]);
          const existing = await db.prepare('SELECT * FROM ' + table + ' WHERE ' + identity).get(...keys);
          if (existing) {
            for (const column of columns) {
              if (existing[column] !== row[column]) throw new Error('An existing record conflicts in ' + table + '.');
            }
            continue;
          }
          const override = table === 'audit' ? ' OVERRIDING SYSTEM VALUE' : '';
          await db.prepare('INSERT INTO ' + table + ' (' + columns.map(quote).join(',') + ')' + override +
            ' VALUES (' + columns.map(() => '?').join(',') + ')').run(...Object.values(row));
        }
      }
      for (const asset of snapshot.assets) {
        for (const original of [true, false]) {
          const bytes = await checkedImage(asset, original);
          const name = original ? 'original' : 'preview.jpg';
          let existing;
          try {
            existing = await objectStore.get(asset.id, name);
          } catch (error) {
            if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
          }
          if (existing && !existing.equals(bytes)) throw new Error('An existing image conflicts with the backup.');
          if (!existing) await objectStore.put(asset.id, name, bytes, 'image/' + (original ? asset.format : 'jpeg'));
          if (!(await objectStore.get(asset.id, name)).equals(bytes)) throw new Error('An uploaded image failed verification.');
        }
      }
      await db.prepare("SELECT setval(pg_get_serial_sequence('audit','id'), GREATEST((SELECT last_value FROM audit_id_seq), COALESCE((SELECT max(id) FROM audit),1)))").get();
    });
    const counts = await db.prepare('SELECT (SELECT count(*) FROM applications) AS applications, (SELECT count(*) FROM assets) AS images, (SELECT count(*) FROM callbacks) AS callbacks').get();
    assert.ok(counts.applications >= snapshot.applications.length && counts.images >= snapshot.assets.length &&
      counts.callbacks >= snapshot.callbacks.length);
    console.log('Neon import verified:', JSON.stringify(counts));
  } finally {
    await db.close();
    objectStore.close();
  }
}
run().catch(error => {
  // Never print row data or a database URL from a provider error.
  console.error('Import stopped:', error.code || (error.constructor === Error ? error.message : error.name));
  process.exitCode = 1;
});
