-- SESSIONS database — full-create snapshot (authoritative "fresh DB" shape).
--
-- For changes to a LIVE db, add a numbered migration under
-- db/migrations/sessions/ — keep this snapshot and the migration set in lockstep
-- (0001_init.sql mirrors this file). See db/migrations/README.md.
--
-- Sessions live in their OWN database, separate from the directory + account
-- shards (DIRECTORY_DB, ACCOUNTS_DB_N), for two reasons: (1) they are high-churn
-- (created on every
-- sign-in, deleted on expiry) and shouldn't share write traffic with Tier-0
-- account data; (2) they are NOT Tier-0 — a lost session regenerates by
-- re-auth, so this db needs none of the irreplaceable-state backup discipline
-- the accounts db does. Because it's a separate db, the initial session minted
-- at create-account is a non-atomic write AFTER the account commits — fine,
-- since a failed session just means "sign in again".
--
-- No FK to users(id): that table is in a different database now. account_db_id
-- is denormalized here so the per-request auth guard resolves
-- "token → user → which accounts db" in a single read, no directory hop.

-- Bearer-token auth. We store the token HASH (sha-256), never the raw token.
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  user_id       TEXT NOT NULL,
  account_db_id TEXT NOT NULL,           -- routing: the user's accounts shard (e.g. '1'), from the directory
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL         -- not in use yet (see middleware/auth.ts)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
