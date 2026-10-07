CREATE TABLE IF NOT EXISTS integration_jobs (
  id TEXT PRIMARY KEY,
  source_namespace TEXT NOT NULL,
  source_repo TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  before_commit TEXT NOT NULL,
  ref TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'blocked', 'conflict', 'integrated')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS integration_jobs_status_idx ON integration_jobs(status, created_at);
