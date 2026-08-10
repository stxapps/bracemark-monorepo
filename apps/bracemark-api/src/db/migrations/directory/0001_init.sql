-- Migration 0001 (directory) — initial schema. Mirrors db/schemas/directory.sql.
-- Applied to the live directory DB via:
--   wrangler d1 migrations apply DIRECTORY_DB --env <development|staging|production>

CREATE TABLE IF NOT EXISTS usernames (
  username      TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  account_db_id TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_usernames_user_id ON usernames(user_id);

-- Subscription purchases — one row per provider subscription. GLOBAL (here, not
-- an account shard) because webhook events after the first are keyed by the
-- provider's id (UNIQUE(source, external_id)) with no username/session to route
-- a shard by. See docs/iap.md and services/iap.ts for the fold to an entitled plan.
CREATE TABLE IF NOT EXISTS purchases (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  source               TEXT NOT NULL,
  external_id          TEXT NOT NULL,
  plan                 TEXT NOT NULL,
  status               TEXT NOT NULL,
  provider_customer_id TEXT,
  expires_at           INTEGER,
  canceled_at          INTEGER,
  linked_external_id   TEXT,  -- Play only: the purchase token this row replaced
  event_occurred_at    INTEGER NOT NULL,
  last_synced_at       INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_purchases_user_id ON purchases(user_id);

-- Pending Paddle checkouts — the account → Paddle handle mapping that exists
-- BEFORE any subscription does, so a first purchase whose webhook never arrived
-- can still be re-found (txn_… → subscription_id → the normal apply path).
-- Paddle can't be queried by our custom_data.userId, so this row is the only
-- key. Short-lived: deleted on resolve, on a canceled/unknown transaction, or
-- once aged out. See docs/iap.md and services/iap.ts.
CREATE TABLE IF NOT EXISTS paddle_checkouts (
  transaction_id TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  plan           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_synced_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_paddle_checkouts_user_id ON paddle_checkouts(user_id);
