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
- **`presign.ts`** — SigV4 presigner for R2's S3-compatible endpoint: what
  `files/sign` answers a client that names no transport — every client shipped
  before the blob route. The native binding can read/write from inside the
  Worker but can't mint a URL the BROWSER can PUT/GET directly. A GET is signed
  with `response-cache-control=no-store`: R2 sends a blob with no caching header
  of its own, and the api cannot set one on a response it never sees.
- **`blob-token.ts`** — the blob route's credential (`../routes/blob.ts`): an
  HMAC token for one object, one method, until an expiry, under a key derived
  from `R2_SECRET_ACCESS_KEY` — the presign's grant in the api's own format, for
  the transfer that goes through the api over HTTP/2/3 instead of to R2's
  HTTP/1.1-only endpoint. See _the blob route_ in
  [../../../../docs/local-first-sync.md](../../../../docs/local-first-sync.md).
  Its `signBlobUrls` builds what `files/sign` answers with `via: 'api'`, called by
  `../services/sync.ts` rather than the gateway: a token names a user and a
  wire path, never an R2 key or the bucket, so it is a pure function of a secret.
- **`upload-receipt.ts`** — what a blob-route PUT answers with: R2's own
  `LastModified` and size for the object it wrote, signed, under the op log's
  fence the PUT token carried. The commit takes it instead of asking R2 whether
  the object landed, and the DO's fence decides whether it still can (_upload
  receipts_ in the same doc). A receipt it cannot read is no receipt, never an
  error. Minted and read by `../services/sync.ts` (`putBlob`, `commitOps`), not
  by the gateway: it touches no bucket, so it is a pure function of a secret.
- **`hmac-key.ts`** — the HKDF derivation both of the above sign with, one key
  per label from `R2_SECRET_ACCESS_KEY`, so a token never verifies as a receipt;
  and `hmacSecret(env)`, the one place that reads that root and answers 500
  `r2_unconfigured` when a deploy lacks it.
- **`user-files.ts`** — the bucket **gateway** (the R2 analogue of the `db`/`do`
  repositories): `list` (fallback full sync), `statMany` (the op-commit
  existence check + quota size, by listing or `head`, for a put without an
  upload receipt), the blob route's `get`/`put` (`put` answering the object's
  stat for its receipt), and the R2 signer `presignUrls` (batch). Unlike the
  D1/DO repos, which each take a single storage handle, `userFilesRepo(env)` takes
  the whole `env`: R2's surface spans TWO bindings — the native bucket binding
  (`USER_FILES`) AND the S3 credential vars (`R2_*`, see
  [`../lib/env.ts`](../lib/env.ts)).

There is **no schema or migration** here (unlike `db`/`do`): R2 is schemaless
object storage, so this folder is access-only.
