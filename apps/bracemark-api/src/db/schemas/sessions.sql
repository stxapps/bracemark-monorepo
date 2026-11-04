-- SESSIONS database — full-create snapshot (authoritative "fresh DB" shape).
--
-- For changes to a LIVE db, add a numbered migration under
-- db/migrations/sessions/ — keep this snapshot and the migration set in lockstep
-- (0001_init.sql + 0002_revoked_at.sql + 0003_signup_counts.sql +
-- 0004_purge_index.sql + 0005_signup_counts_cap.sql together produce this
-- file). See db/migrations/README.md.
--
-- Sessions live in their OWN database, separate from the directory + account
-- shards (DIRECTORY_DB, ACCOUNTS_DB_N), for two reasons: (1) they are high-churn
-- (created on every sign-in, renewed at most daily while in use, purged a year
-- after they end) and shouldn't share write traffic with Tier-0
-- account data; (2) they are NOT Tier-0 — a lost session regenerates by
-- re-auth, so this db needs none of the irreplaceable-state backup discipline
-- the accounts db does. ⚠ And it is never restored BACKWARD: a restore undoes
-- revocations and password-change expiries. If it is damaged, empty the table
-- (docs/sessions.md, _the sessions database_).
--
-- Because it's a separate db, the initial session minted at create-account is a
-- non-atomic write AFTER the account commits — fine, since a failed session just
-- means "sign in again".
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
  expires_at    INTEGER NOT NULL,        -- idle deadline; slid forward by the guard (middleware/auth.ts)
  last_seen_at  INTEGER NOT NULL,        -- set at sign-in, then moves with each renewal (at most daily); read as totals
  revoked_at    INTEGER                  -- NULL, or when it was explicitly revoked (0002)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
-- Cleanup's two clocks in one index (0004): unrevoked rows by expires_at,
-- revoked ones by revoked_at, each a range over it (sessionsRepo.purge).
CREATE INDEX IF NOT EXISTS idx_sessions_purge ON sessions(revoked_at, expires_at);

-- The per-network daily signup counter (0003): one row per (network, UTC day),
-- the network an HMAC, never an address. Disposable like the sessions beside it;
-- the daily cron deletes past days. services/signup-cap.ts.
CREATE TABLE IF NOT EXISTS signup_counts (
  network_hash TEXT NOT NULL,
  day          INTEGER NOT NULL,         -- days since the epoch, UTC
  count        INTEGER NOT NULL,
  cap          INTEGER,                  -- the cap it was counted against (0005); NULL on older rows
  PRIMARY KEY (network_hash, day)
);
CREATE INDEX IF NOT EXISTS idx_signup_counts_day ON signup_counts(day);
