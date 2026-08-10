-- Migration 0001 (sessions) — initial schema. Mirrors db/schemas/sessions.sql.
-- Applied to live sessions DBs via:
--   wrangler d1 migrations apply SESSIONS_DB --env <development|staging|production>

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL,
  account_db_id TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
