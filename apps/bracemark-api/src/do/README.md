# user-data (Durable Object)

`USER_DATA` is a per-user **Durable Object** SQLite store — one DO instance per
user, addressed by `idFromName(userId)` (see `userDataStub` in `user-data.ts`).
The user is the DO's whole scope, so rows need **no `user_id` column**, and there
is no shard-assignment table to maintain (the win over hand-sharded D1). The DO is
created lazily on first access — no provisioning step at account creation.

This is **NOT a D1 database.** A DO's SQLite lives inside the object and is
reachable only from the DO class via `ctx.storage.sql`. `wrangler d1 migrations`
does **not** touch it. For the D1 side (master: `users`, `sessions`), see
[../db/migrations/README.md](../db/migrations/README.md).

The server only ever stores **metadata** about encrypted blobs that live in R2; R2
is the source of truth for file existence/content, and the op log below is a
disposable accelerator for the incremental sync pull (rebuildable from an R2
listing). See [../../../../docs/local-first-sync.md](../../../../docs/local-first-sync.md).

## migrations are in code

There is no external `wrangler` command to migrate a DO, and the schema must be
**inlined in the bundle** (a Worker can't read `.sql` files at runtime). So
migrations are TypeScript, versioned by a tiny `schema_version` table (NOT
`PRAGMA user_version` — workerd's DO SQLite authorizer rejects that PRAGMA with
`SQLITE_AUTH`, which would brick the DO on construction):

- The single source of truth is the **`MIGRATIONS` array + `migrate()`** in
  `user-data.ts`. Entry `i` upgrades `schema_version` `i → i+1`. The array holds the
  literal `CREATE` SQL, so **read it there to see the current schema** — there is
  deliberately no separate snapshot to drift out of lockstep. (Unlike master,
  whose `master.sql` exists because it is an _applied_ create script; a DO has no
  create-from-snapshot path — it is only ever built by replaying this array, so a
  snapshot would be pure non-applied duplication.)
- `migrate()` runs in the DO constructor under `blockConcurrencyWhile`, so a DO
  finishes upgrading **before** it serves any request. Each user's DO migrates
  itself lazily on first touch after a deploy — there is no fan-out step to
  "apply to every DO".

**Rule:** to change the DO schema, **append** a new entry to `MIGRATIONS` (never
edit a shipped entry — DOs already past that version won't re-run it).

## wrangler wiring

`wrangler.jsonc` (per env) declares the binding and marks the class SQLite-backed:

```jsonc
"durable_objects": { "bindings": [{ "name": "USER_DATA", "class_name": "UserDataDO" }] },
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["UserDataDO"] }]
```

That `migrations` block is the **class** migration (it makes the DO SQLite-backed
and is bumped only for class add/rename/delete) — it is NOT the table/schema
migration, which lives in code as described above. The class must also be
**exported** from the entry module (`src/worker.ts`) for the runtime to find it.
