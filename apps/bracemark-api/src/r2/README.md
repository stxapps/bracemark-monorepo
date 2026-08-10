# r2 (object storage)

`USER_FILES` is the single **R2 bucket** holding every user's encrypted blobs.
This is the third storage primitive alongside [`../db`](../db) (D1, relational
master) and [`../do`](../do) (per-user Durable Object SQLite) — and, like them,
all access to it goes through this folder rather than touching the binding inline
in services, routes, or the DO.

- **`keys.ts`** — R2 object-key namespacing. Every user's blobs live under
  `users/{uid}/`; the wire only ever carries the path RELATIVE to that prefix
  (see `syncPathSchema` in `@stxapps/shared`). The server prepends the prefix
  derived from the authenticated session, so a client can't name another user's
  object — that prefixing IS the authorization check.
- **`presign.ts`** — SigV4 presigner for R2's S3-compatible endpoint. The native
  binding can read/write from inside the Worker but can't mint a URL the BROWSER
  can PUT/GET directly, which is the whole point of the local-first data path
  (blob bytes never touch the API). See
  [../../../../docs/local-first-sync.md](../../../../docs/local-first-sync.md).
- **`user-files.ts`** — the bucket **gateway** (the R2 analogue of the `db`/`do`
  repositories): `list` (fallback full sync), `head` (op-commit existence check +
  quota size), and `presignUrls` (batch). Unlike the D1/DO repos, which each take
  a single storage handle, `userFilesRepo(env)` takes the whole `env`: R2's
  surface spans TWO bindings — the native bucket binding (`USER_FILES`) AND the
  S3 credential vars (`R2_*`, see [`../lib/env.ts`](../lib/env.ts)).

There is **no schema or migration** here (unlike `db`/`do`): R2 is schemaless
object storage, so this folder is access-only.
