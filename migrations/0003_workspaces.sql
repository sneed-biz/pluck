CREATE TABLE IF NOT EXISTS workspaces (
  namespace TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (namespace, repo_name)
);

CREATE INDEX IF NOT EXISTS workspaces_active_idx ON workspaces(namespace, repo_name, active);
