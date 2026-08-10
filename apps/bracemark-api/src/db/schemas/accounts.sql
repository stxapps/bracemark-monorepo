-- ACCOUNTS database (a SHARD) — full-create snapshot ("fresh DB" shape).
--
-- This schema is applied to EACH account shard (ACCOUNTS_DB_1, ACCOUNTS_DB_2,
-- …). For changes to a LIVE db, add a numbered migration under
-- db/migrations/accounts/ — keep this snapshot and the migration set in lockstep
-- (0001_init.sql mirrors this file). See db/migrations/README.md.
--
-- Holds a shard of account rows: `users` (identity + credential) and
-- `account_keys` (the wrapped-DEK doors). The username is NOT here — it lives in
-- the global `usernames` directory (DIRECTORY_DB), which owns uniqueness and
-- routing. These two tables stay TOGETHER in the same shard forever so the
-- credential and its Tier-0 key material commit in one transaction. Only small,
-- bounded-per-user rows live here (no bulk data — bookmarks are in the USER_DATA
-- durable objects), so a shard holds millions of accounts before the next one is
-- needed. Which shard a user is in is recorded by `account_db_id` in the
-- directory (and denormalized onto the session); resolve it via db/db-routes.ts.

-- Account identity + credential. Keyed by the random server-minted user_id (the
-- DO address). public_key is the Ed25519 credential the server verifies sign-in
-- signatures against (hex) — NOT an identifier. Under the DEK model it is derived
-- from the random DEK, so it is STABLE across password changes (those only
-- re-wrap the DEK; see account_keys) and changes only on a rare DEK rotation.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The "doors": one wrapped-DEK blob per access method. Each door derives a KEK
-- and AEAD-wraps its own copy of the 32-byte DEK; any one unwraps it.
-- wrapped_dek = AES-256-GCM(KEK, DEK, aad = door_type) — the KEK already binds
-- the user (the password salt folds in the username), so the AAD only binds the
-- door. Same shard as `users`, so create-account writes both in one atomic batch.
CREATE TABLE IF NOT EXISTS account_keys (
  user_id     TEXT NOT NULL REFERENCES users(id),
  door_type   TEXT NOT NULL,            -- 'password' | 'recovery' | 'passkey'
  wrapped_dek BLOB NOT NULL,
  iv          BLOB NOT NULL,            -- GCM nonce for this wrap
  version     INTEGER NOT NULL,         -- bumped on each re-wrap (audit/debug)
  created_at  INTEGER NOT NULL,         -- door first created (stable across re-wraps)
  updated_at  INTEGER NOT NULL,         -- last re-wrap; = created_at at insert (a re-wrap UPDATEs in place, bumping version)
  PRIMARY KEY (user_id, door_type)
);
