# database migrations

bracemark-api has **two database roles with two DIFFERENT migration models** — don't
conflate them:

- **D1 databases** — real **D1**, migrated by `wrangler` from the numbered `.sql`
  files under `migrations/<role>/`. There are three roles, each its own migration
  history:
  - **directory** (`DIRECTORY_DB`) — the global `usernames` directory: the
    uniqueness namespace + username→shard routing. Never sharded.
  - **accounts** (`ACCOUNTS_DB_1`, … one binding per shard) — `users` +
    `account_keys`. The `accounts` migration set is applied to **each** shard.
  - **sessions** (`SESSIONS_DB`) — bearer-token `sessions` only. Separate db:
    high-churn and not Tier-0 (a lost session regenerates by re-auth).
  - All hold only small, bounded-per-user rows, so none nears D1's 10 GB cap;
    `account_db_id` (in the directory + sessions) routes a user to their shard
    (see `db/db-routes.ts`). create-account is cross-DB (claim-then-write) — see
    `services/account.ts`.
- **user-data** (`USER_DATA`) — a per-user **Durable Object** SQLite store
  (`src/do/user-data.ts`), one DO instance per user (addressed by
  `idFromName(userId)`). **NOT a D1 database** — `wrangler d1 migrations` does
  **not** touch it; it is migrated **in code**. Documented separately in
  [../../do/README.md](../../do/README.md).

This file covers the **D1** databases only.

## D1 — wrangler-applied

`db/schemas/<role>.sql` is each db's **full-create snapshot** (authoritative shape
of a fresh DB, at-a-glance reference). `db/migrations/<role>/NNNN_*.sql` are the
**incremental** changes applied to live DBs in order; each `0001_init.sql` mirrors
its snapshot.

**Rule:** any change to a deployed DB is a new numbered migration — never edit a
live table by hand. Keep `schemas/<role>.sql` and the migration set in lockstep:
when you add `0002_*.sql`, fold the same change into the snapshot so a fresh DB
matches a migrated one.

`migrations_dir` is set per-binding in `wrangler.jsonc` (`DIRECTORY_DB` →
`src/db/migrations/directory`, `ACCOUNTS_DB_1` → `src/db/migrations/accounts`,
`SESSIONS_DB` → `src/db/migrations/sessions`). Target a DB by its **binding name**
and pass the env. Convenience Nx targets wrap these (see
`apps/bracemark-api/package.json` → `migrate`):

```bash
# local (miniflare) — applied inside .wrangler/ state
wrangler d1 migrations apply DIRECTORY_DB --env development
wrangler d1 migrations apply ACCOUNTS_DB_1 --env development
wrangler d1 migrations apply SESSIONS_DB --env development

# staging / production (needs that account's API token)
wrangler d1 migrations apply DIRECTORY_DB --env staging

# list applied/pending
wrangler d1 migrations list DIRECTORY_DB --env development
```

When a shard is added, apply the **same** `accounts` set to it:
`wrangler d1 migrations apply ACCOUNTS_DB_2 --env <tier>`.
