import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, transaction } from '../server/database.mjs';
import { DAY } from '../server/security.mjs';

export async function retain(directory, { apply = false, now = Date.now() } = {}) {
  if (!existsSync(join(directory, 'intake.sqlite'))) throw new Error('Source database is missing.');
  const db = openDatabase(directory);
  try {
    const results = transaction(db, () => {
      const applications = db.prepare(`SELECT id FROM applications WHERE status IN ('draft','withdrawn')
        AND updated_at<?`).all(now - 30 * DAY);
      const callbacks = db.prepare(`SELECT id FROM callbacks WHERE status IN ('completed','closed')
        AND updated_at<?`).all(now - 90 * DAY);
      const finishedMail = db.prepare(`SELECT id FROM outbox WHERE state='sent' AND sent_at<?`).all(now - 90 * DAY);
      if (apply) {
        const removeAudit = db.prepare('DELETE FROM audit WHERE subject_kind=? AND subject_id=?');
        const removeApplication = db.prepare('DELETE FROM applications WHERE id=?');
        const removeCallback = db.prepare('DELETE FROM callbacks WHERE id=?');
        for (const { id } of applications) {
          removeAudit.run('application', id);
          removeApplication.run(id);
        }
        for (const { id } of callbacks) {
          removeAudit.run('callback', id);
          removeCallback.run(id);
        }
        db.prepare(`DELETE FROM outbox WHERE state='sent' AND sent_at<?`).run(now - 90 * DAY);
        for (const table of ['resume_links', 'artist_sessions', 'reviewer_sessions']) {
          db.prepare('DELETE FROM ' + table + ' WHERE expires_at<=?').run(now);
        }
        db.prepare('DELETE FROM rate_buckets WHERE window<?').run(now - 2 * DAY);
        db.prepare('DELETE FROM landing_sessions WHERE created_at<?').run(now - 90 * DAY);
      }
      return { applications: applications.length, callbacks: callbacks.length, finishedMail: finishedMail.length, media: 0, previewMail: 0 };
    });

    const referenced = new Set(db.prepare('SELECT id FROM assets').all().map((row) => row.id));
    const vault = join(directory, 'media');
    if (existsSync(vault)) {
      for (const entry of await readdir(vault, { withFileTypes: true })) {
        if (!entry.isDirectory() || referenced.has(entry.name)) continue;
        if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.name)) continue;
        const target = join(vault, entry.name);
        if ((await stat(target)).mtimeMs >= now - DAY) continue;
        results.media++;
        if (apply) await rm(target, { force: true, recursive: true });
      }
    }
    const preview = join(directory, 'dev-mail');
    if (existsSync(preview)) {
      for (const entry of await readdir(preview, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[0-9a-f-]{36}\.json(?:\.tmp)?$/i.test(entry.name)) continue;
        const target = join(preview, entry.name);
        if ((await stat(target)).mtimeMs >= now - 7 * DAY) continue;
        results.previewMail++;
        if (apply) await rm(target, { force: true });
      }
    }
    if (apply) db.exec('PRAGMA wal_checkpoint(PASSIVE);');
    return results;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  const apply = process.argv[2] === '--apply';
  try {
    const summary = await retain(resolve(process.env.DATA_DIR || 'data'), { apply });
    console.log(apply ? 'Retention applied:' : 'Retention report. Use --apply to remove eligible records:', summary);
  } catch (error) {
    console.error('Retention failed: ' + (error.code || error.message));
    process.exitCode = 1;
  }
}
