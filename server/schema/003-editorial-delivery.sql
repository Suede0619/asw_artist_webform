CREATE TABLE IF NOT EXISTS editorial_deliveries (
  issue_date TEXT PRIMARY KEY REFERENCES editorial_issues(issue_date),
  campaign_id TEXT NOT NULL UNIQUE,
  digest TEXT NOT NULL,
  started_at BIGINT NOT NULL
);
