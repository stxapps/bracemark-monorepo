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
`SESSIONS_DB` → `src/db/migrations/sessions`). Target a DB by its **binding name**,
pass the env, and pass `--local` or `--remote` — see the warning below.

```bash
# local (miniflare) — applied inside .wrangler/ state
wrangler d1 migrations apply DIRECTORY_DB --env development --local
wrangler d1 migrations apply ACCOUNTS_DB_1 --env development --local
wrangler d1 migrations apply SESSIONS_DB --env development --local

# staging / production (needs that account's API token)
wrangler d1 migrations apply DIRECTORY_DB --env staging --remote

# list applied/pending — also the cheapest check that a binding's database_id
# is real and reachable by the token you are holding
wrangler d1 migrations list DIRECTORY_DB --env staging --remote
```

When a shard is added, apply the **same** `accounts` set to it:
`wrangler d1 migrations apply ACCOUNTS_DB_2 --env <tier> --remote`.

### ⚠ `--remote` is not the default, and omitting it looks like success

`wrangler d1 migrations apply` **defaults to the local miniflare database** when
neither `--local` nor `--remote` is given. It prints one line of prose about it
(`Resource location: local`), applies the migrations to a SQLite file under
`.wrangler/`, prints ✅, and exits 0. There is no error and no warning: a
production migration run without `--remote` leaves the real database untouched
and the Worker serving against tables that do not exist, and the only evidence is
a line in the middle of otherwise-successful output.

The `d1-migrate` target's `staging` and `production` configurations carry
`--remote` for exactly this reason, and `development` carries an explicit
`--local` so that reading the three side by side shows the flag is deliberate
rather than absent. **Never delete one of them**, and never add a new binding's
command without it — nothing lints this, no type sees it, and no test in either
runner can reach a remote D1.

`tools/scripts/deploy-worker.sh` is the safe path for a real tier: it applies
each binding `--remote` before deploying the Worker, having first proved the
token reaches that tier's account (`docs/hosting.md`, _deploying the workers_).

### the Nx target is `d1-migrate`, not `migrate`

**`migrate` is a built-in Nx command** — `nx migrate @nx/workspace@latest`, the
package-upgrade tool. A target named `migrate` is still runnable as
`nx run @stxapps/bracemark-api:migrate`, but the shorthand everything else in
this repo uses, `nx migrate @stxapps/bracemark-api`, silently means something
else entirely: Nx parses the project name as a package to upgrade the workspace
to. Hence the `d1-` prefix, which also says which of this file's two migration
models it drives (the Durable Object's runs in code — [../../do/README.md](../../do/README.md)).

```bash
npm run d1:migrate               # development, --local
npm run d1:migrate:staging       # staging, --remote
npm run d1:migrate:production    # production, --remote
```
