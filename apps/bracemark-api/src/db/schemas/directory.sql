-- DIRECTORY database — full-create snapshot (authoritative "fresh DB" shape).
--
-- For changes to a LIVE db, add a numbered migration under
-- db/migrations/directory/ — keep this snapshot and the migration set in lockstep
-- (0001_init.sql mirrors this file). See db/migrations/README.md.
--
-- The GLOBAL, never-sharded registry: the username uniqueness namespace and the
-- username→account routing map. It is tiny (~70 B/row → ~140M usernames in one
-- 10 GB D1), so it outscales the account shards (~6.6M each) ~20× and effectively
-- never needs sharding itself. When `ACCOUNTS_DB_N` shards fill, this directory
-- stays put and just gains rows with new `account_db_id`s. It's also the natural
-- home for any future small global lookup tables.
--
-- Because the directory and the account rows now live in SEPARATE databases,
-- create-account is cross-DB: it CLAIMS the username here first, then writes the
-- account in the shard, then compensates (releases the claim) if that write
-- fails. See services/account.ts and docs/account.md.

-- The username directory: PRIMARY KEY(username) IS the case-insensitive UNIQUE
-- constraint, and the claim is a single `INSERT ... ON CONFLICT DO NOTHING`
-- (race-free; no read-then-write). Usernames are stored canonical
-- (trim→NFKC→lowercase, canonicalizeUsername in @stxapps/shared) so the handle
-- matches the per-user salt input exactly. account_db_id is the EXPLICIT shard
-- this user's rows live in (e.g. '1' ⇒ ACCOUNTS_DB_1), assigned at create-account
-- by assignAccountDbId() and resolved by db/db-routes.ts. NOT NULL — every row
-- self-describes its shard, so adding a shard never rewrites existing rows.
CREATE TABLE IF NOT EXISTS usernames (
  username      TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  account_db_id TEXT NOT NULL,
  created_at    INTEGER NOT NULL,         -- when the name was claimed (audit only; never updated)
  deleted_at    INTEGER                   -- non-NULL = TOMBSTONE: the account was deleted, the name stays occupied (see docs/data-lifecycle.md). The PK keeps re-claims failing; user_id is retained so a delete-account retry can still bind the name to its (gone) account. Releasing tombstones after a cooldown is a future policy loosen — never the reverse.
);
CREATE INDEX IF NOT EXISTS idx_usernames_user_id ON usernames(user_id);

-- Subscription purchases — one row per provider subscription.
-- GLOBAL (here, not an account shard) because webhook events
-- after the first are keyed by the PROVIDER's id — `UNIQUE(source, external_id)`
-- — with no username/session in hand to route a shard by; a per-shard table
-- would force the forbidden try-every-shard scan. Rows are tiny and bounded per
-- user (a handful, ever), and money-adjacent state belongs in the Tier-0 backup
-- set anyway. `user_id` has NO FK (users live in the shards) and is written once
-- at first sight of the subscription, never overwritten by later events.
--
-- source:      'paddle' | 'appstore' | 'playstore' | 'manual' (a server-side
--              grant — comps / lifetime deals — with no provider to verify).
-- external_id: the provider's subscription identity — Paddle subscription id,
--              App Store originalTransactionId, Play purchase token; a minted
--              id for 'manual'. The webhook upsert key.
-- plan/status: normalized (shared PLANS; 'active'|'trialing'|'past_due'|
--              'paused'|'canceled'), mapped from provider vocab at the webhook
--              edge so the fold never sees provider-specific states.
-- provider_customer_id: Paddle customer id (ctm_…), needed to mint customer-
--              portal sessions. NULL for other sources.
-- expires_at:  epoch ms the paid period runs to; NULL = non-expiring
--              (manual/lifetime). canceled_at: when cancellation was scheduled
--              (period end) — entitled until expires_at, but willRenew=false.
-- linked_external_id: PLAY ONLY — the purchase token this row REPLACED. Play
--              re-keys the subscription on an upgrade/downgrade/re-signup
--              (Paddle and Apple keep one id for life), so a plan change writes
--              a NEW row and the old one must be retired or it goes on
--              entitling; see services/iap.ts supersedeLinkedPlayPurchase. Kept
--              on the row so walking a Z→Y→X replacement chain is a local read
--              rather than a fetch per hop. NULL for every other source.
-- event_occurred_at: provider event time last applied — the out-of-order
--              webhook guard (an upsert loses to a newer stored event).
-- last_synced_at: epoch ms of the last REFRESH ATTEMPT against the provider's
--              API (services/iap.ts refreshPurchase) — success or failure. It
--              is a DEBOUNCE clock, not a freshness proof: its only job is to
--              stop the status read from re-asking a provider (a down one
--              especially) on every poll. Webhook-applied state stamps it too
--              (the event IS a sync), so a healthy subscription never refetches.
CREATE TABLE IF NOT EXISTS purchases (
  id                   TEXT PRIMARY KEY,  -- server-minted (newId())
  user_id              TEXT NOT NULL,
  source               TEXT NOT NULL,
  external_id          TEXT NOT NULL,
  plan                 TEXT NOT NULL,
  status               TEXT NOT NULL,
  provider_customer_id TEXT,
  expires_at           INTEGER,
  canceled_at          INTEGER,
  linked_external_id   TEXT,
  event_occurred_at    INTEGER NOT NULL,
  last_synced_at       INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_purchases_user_id ON purchases(user_id);

-- Pending Paddle checkouts — the ONE mapping from an account to a Paddle-side
-- handle before any subscription exists. GLOBAL, beside `purchases`, for the
-- same reason (no username/session in hand when reconciling) and because it is
-- the pre-row half of the same story.
--
-- Why it exists: Paddle has no way to ask "what does this user have" — every
-- list endpoint filters on Paddle's own ids, and our `custom_data.userId` is
-- returned but never queryable. So if the `subscription.created` webhook for a
-- FIRST purchase is lost (delivery exhausted, destination disabled, or we 200'd
-- and couldn't apply — see docs/iap.md), no `purchases` row is ever written, and
-- the staleness refresh has nothing to iterate: the user has paid and the server
-- cannot find out. `createPaddleTransaction` already mints a `txn_…` and hands
-- it to the client; persisting it here keeps the only key that can re-find that
-- purchase (txn → subscription_id → the normal apply path).
--
-- Rows are SHORT-LIVED by design: deleted the moment they resolve (the
-- `purchases` row is the durable record), when Paddle says the transaction is
-- canceled/unknown, or once they age past the resolve TTL. They are NOT an
-- audit log — an abandoned checkout is indistinguishable from a lost webhook,
-- which is precisely why the row is cheap to drop.
--
-- last_synced_at: epoch ms of the last resolve ATTEMPT (success or failure) —
--              the debounce clock, same role as purchases.last_synced_at but on
--              a much shorter window (services/iap.ts): this row's whole life is
--              the minute after a payment, where the user IS watching.
CREATE TABLE IF NOT EXISTS paddle_checkouts (
  transaction_id TEXT PRIMARY KEY,       -- Paddle txn_… (the provider's lookup key)
  user_id        TEXT NOT NULL,          -- from the SESSION at checkout creation; no FK (users live in the shards)
  plan           TEXT NOT NULL,          -- what they set out to buy (ops/logs only — the real plan comes from the subscription's price id)
  created_at     INTEGER NOT NULL,
  last_synced_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_paddle_checkouts_user_id ON paddle_checkouts(user_id);
