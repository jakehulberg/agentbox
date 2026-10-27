-- D1: the only cross-session table. Each Session DO upserts its row on every status change; the DO is the truth.
CREATE TABLE IF NOT EXISTS sessions_index (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  repo       TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  status     TEXT NOT NULL,
  pr_url     TEXT,
  cost_usd   REAL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_by_owner ON sessions_index (owner, updated_at);
