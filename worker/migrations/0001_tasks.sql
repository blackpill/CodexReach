CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL, issue_number INTEGER NOT NULL,
  actor_id INTEGER NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL, lease_token TEXT, lease_version INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER, runner_id TEXT, UNIQUE(repository_id, issue_number)
);
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY, repository_id INTEGER NOT NULL, issue_number INTEGER NOT NULL, received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_pending ON tasks(status, lease_until, created_at);
