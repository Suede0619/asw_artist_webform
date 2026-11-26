CREATE TABLE IF NOT EXISTS editorial_records (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL CHECK(category IN ('calendar', 'sponsor')),
  state TEXT NOT NULL CHECK(state IN ('pending', 'approved', 'declined', 'withdrawn')),
  revision INTEGER NOT NULL,
  draft TEXT NOT NULL,
  approved TEXT,
  image_id TEXT,
  approved_image_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT
);
CREATE INDEX IF NOT EXISTS editorial_review_queue ON editorial_records(category,state,updated_at);
CREATE INDEX IF NOT EXISTS editorial_public_media ON editorial_records(approved_image_id);
CREATE TABLE IF NOT EXISTS editorial_issues (
  issue_date TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('draft','approved','sent','expired')),
  digest TEXT NOT NULL,
  contents TEXT NOT NULL,
  campaign_id TEXT UNIQUE,
  updated_at BIGINT NOT NULL,
  review_note TEXT NOT NULL DEFAULT '',
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS editorial_slots (
  issue_date TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES editorial_records(id),
  revision INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  checkout_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('reserved','paid','released','refund_review','refunded')),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS editorial_jobs (
  name TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  lease_until BIGINT NOT NULL,
  completed_at BIGINT,
  result TEXT
);
