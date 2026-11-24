import { copyFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mediaPath } from '../server/media.mjs';

export async function backupIntake(source, target) {
  if (!existsSync(join(source, 'intake.sqlite'))) throw new Error('Source database is missing.');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await mkdir(target, { mode: 0o700 }); // Refuse to overwrite an existing backup.
  try {
    const db = new DatabaseSync(join(source, 'intake.sqlite'), { readOnly: true });
    try {
      await backup(db, join(target, 'intake.sqlite'));
    } finally {
      db.close();
    }
    const snapshot = new DatabaseSync(join(target, 'intake.sqlite'), { readOnly: true });
    let assets;
    try {
      if (snapshot.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
        throw new Error('The copied database failed its integrity check.');
      }
      assets = snapshot.prepare('SELECT id FROM assets').all();
    } finally {
      snapshot.close();
    }
    for (const { id } of assets) {
      if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Invalid media ID in snapshot.');
      await mkdir(join(target, 'media', id), { recursive: true, mode: 0o700 });
      await copyFile(mediaPath(source, id, true), mediaPath(target, id, true));
      await copyFile(mediaPath(source, id), mediaPath(target, id));
    }
    if (existsSync(join(source, 'mail-queue.key'))) {
      await copyFile(join(source, 'mail-queue.key'), join(target, 'mail-queue.key'));
    }
    return assets.length;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const source = resolve(process.env.DATA_DIR || 'data');
  const date = new Date().toISOString().replace(/[:.]/g, '-');
  const target = resolve(process.argv[2] || join('backups', date));
  try {
    const mediaCount = await backupIntake(source, target);
    console.log('Created a private database backup with ' + mediaCount + ' media records in ' + target);
  } catch (error) {
    console.error('Backup failed: ' + (error.code || error.message));
    process.exitCode = 1;
  }
}
