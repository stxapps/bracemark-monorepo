-- Migration 0001 (accounts) — initial schema. Mirrors db/schemas/accounts.sql.
-- Applied to EACH account shard via:
--   wrangler d1 migrations apply ACCOUNTS_DB_1 --env <development|staging|production>
--   (and ACCOUNTS_DB_2, … as shards are added)

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS account_keys (
  user_id     TEXT NOT NULL REFERENCES users(id),
  door_type   TEXT NOT NULL,
  wrapped_dek BLOB NOT NULL,
  iv          BLOB NOT NULL,
  version     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, door_type)
);
