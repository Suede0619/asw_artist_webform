import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const applicationColumns = `
  id TEXT PRIMARY KEY, email TEXT UNIQUE COLLATE NOCASE,
  campaign TEXT NOT NULL, status TEXT NOT NULL
    CHECK(status IN ('draft','submitted','changes_requested','published','withdrawn')),
  revision INTEGER NOT NULL, draft TEXT NOT NULL CHECK(json_valid(draft)),
  review_note TEXT NOT NULL DEFAULT '', policy_version TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  first_submitted_at INTEGER, submitted_at INTEGER
`;

function migrateDirectDrafts(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    transaction(db, () => {
      if (db.prepare('PRAGMA user_version').get().user_version !== 1) return;
      db.exec(`
        CREATE TABLE updated_applications (${applicationColumns});
        INSERT INTO updated_applications (
          id,email,campaign,status,revision,draft,review_note,policy_version,
          created_at,updated_at,first_submitted_at,submitted_at
        )
        SELECT id,email,campaign,status,revision,
          json_set(draft,'$.profile.email',COALESCE(json_extract(draft,'$.profile.email'),email,'')),
          review_note,policy_version,created_at,updated_at,first_submitted_at,submitted_at
        FROM applications;
        DROP TABLE applications;
        ALTER TABLE updated_applications RENAME TO applications;
        ALTER TABLE resume_links ADD COLUMN recipient TEXT;
        PRAGMA user_version = 2;
      `);
      if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('The draft migration would leave missing references.');
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function openDatabase(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'intake.sqlite'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 2) {
    db.close();
    throw new Error('The intake database requires a newer application version.');
  }
  if (!version) {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE applications (${applicationColumns});
      CREATE TABLE versions (
        app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, kind TEXT NOT NULL,
        data TEXT NOT NULL CHECK(json_valid(data)), policy_version TEXT, created_at INTEGER NOT NULL,
        PRIMARY KEY(app_id, revision)
      );
      CREATE TABLE assets (
        id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        request_key TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('portrait','work')),
        format TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
        bytes INTEGER NOT NULL, created_at INTEGER NOT NULL,
        UNIQUE(app_id, request_key)
      );
      CREATE INDEX assets_by_application ON assets(app_id, created_at);
      CREATE TABLE resume_links (
        hash TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL, used_at INTEGER, recipient TEXT
      );
      CREATE TABLE artist_sessions (
        hash TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE reviewer_sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE callbacks (
        id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE,
        campaign TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
        best_time TEXT NOT NULL, question TEXT NOT NULL, consent_at INTEGER NOT NULL,
        owner TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','acknowledged','completed','closed')),
        note TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX open_callback_phone ON callbacks(campaign, phone)
        WHERE status IN ('open','acknowledged');
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
        actor TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX audit_subject ON audit(subject_kind,subject_id,id DESC);
      CREATE TABLE reports (
        app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE, request_key TEXT NOT NULL,
        kind TEXT NOT NULL, work_id TEXT, note TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(app_id, request_key)
      );
      CREATE TABLE publications (
        app_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,
        slug TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(json_valid(data)),
        revision INTEGER NOT NULL, published_at INTEGER NOT NULL
      );
      CREATE TABLE public_assets (
        app_id TEXT NOT NULL REFERENCES publications(app_id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        PRIMARY KEY(app_id,asset_id)
      );
      CREATE INDEX public_asset_lookup ON public_assets(asset_id);
      CREATE TABLE outbox (
        id TEXT PRIMARY KEY, event_key TEXT NOT NULL UNIQUE,
        app_id TEXT REFERENCES applications(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, payload TEXT,
        state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed')),
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, sent_at INTEGER, last_error TEXT
      );
      CREATE INDEX outbox_due ON outbox(state,next_at);
      CREATE TABLE rate_buckets (
        bucket TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY(bucket, window)
      );
      CREATE TABLE landing_sessions (id TEXT PRIMARY KEY, campaign TEXT NOT NULL, created_at INTEGER NOT NULL);
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }
  if (version === 1) migrateDirectDrafts(db);
  return db;
}

export function transaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = run();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
