## local-first sync

How bracemark keeps data on the device as the source of truth and syncs end-to-end
encrypted files to the server. See [architecture.md](./architecture.md) for the
package layering, [api-contracts.md](./api-contracts.md) for the contract-first
endpoint pattern this builds on, and [account.md](./account.md) for the
random data key (`@stxapps/web-crypto`) that the password door unwraps and that
protects every blob described here.

### the shape of the problem

bracemark is **local-first**, with **one entity per encrypted file** and
**end-to-end encryption**:

- an entity (a bookmark's metadata, its content/page-copy, a tag, a list, the
  settings) is encrypted on the client, then uploaded as an opaque blob to
  storage (Cloudflare R2) via a signed URL;
- on download, the blob is fetched, decrypted, and written to a local store
  (IndexedDB via Dexie);
- the UI reads from the local store, never from the network.

The decisive constraint is that **the server never sees your library in
plaintext.** The Hono/Workers API and R2 cannot read, index, query, diff, or
conflict-resolve on content. That rules out the server-intelligent local-first
frameworks (ElectricSQL, PowerSync, TanStack DB) — their value is server-side
knowledge of your data, which E2E encryption forbids — and makes the key-value /
document sync engines (Replicache, RxDB replication) an awkward fit, since our
transport is "encrypted blob per file via signed URL," not row/document sync.
This is the Gaia/Blockstack per-file encrypted-storage model — well-trodden
ground.

> **Say it that way, and not "`api.bracemark.com` only ever sees ciphertext."**
> That shorthand was quoted across four docs and four call sites as though it
> were settled, and it is false: `bracemark-api` is ONE Worker serving auth, sync
> AND billing, over a username directory, an accounts shard, a sessions DB, a
> purchases table and R2 (`apps/bracemark-api/wrangler.jsonc`) — so the same host
> that cannot read a link holds your username, your public key, your sessions and
> your subscription row in the clear. What is genuinely ciphertext-only is **the
> library**, and that is the whole of what this constraint buys. The distinction
> is not pedantry: the shorthand leaked into public marketing copy — a site-wide
> meta description and the landing page's loudest claim — before anyone checked
> it against the schema, and a privacy claim a reader can falsify costs more than
> the fact it was hiding. `R2 only ever sees ciphertext` IS true and is the one
> place to keep saying it (`packages/web-react/src/sync/r2.ts`): R2 is a blob
> store with nothing else in it. For the full inventory of what the server does
> learn, see _crypto boundary & what the server still learns_; for the planes
> this file does not cover, [account.md](./account.md) and [iap.md](./iap.md).
>
> **Two later spellings of the same error, both found in public copy after the
> shorthand above was retired, because neither one repeats its words.**
>
> - **An ENUMERATION that closes.** "…your username, and your subscription if you
>   buy one. That is the end of the list." (the landing page's `GUARANTEES`) and
>   "no email, nothing else on file" (Settings → Account, both apps). Each named a
>   true subset and then asserted completeness, and each omitted the public key and
>   the sessions row that /privacy has always inventoried — so the surfaces that
>   sound the most rigorous were the ones a reader could disprove by opening the
>   policy they link to. Name the residual **or** point at the inventory; never
>   close the list from a surface that is not the inventory.
> - **A claim about what we SEE rather than what we HOLD.** The site-wide meta
>   description read "we see your username and your plan, never a link" — true of
>   `bracemark-api` and false of us, because `bracemark-extractor` is handed a
>   plaintext URL by construction whenever the opt-in setting is on
>   ([link-extraction.md](./link-extraction.md), _server extraction_). Scoping a
>   claim to a component we do not name is the same move as inventing a "sync
>   server", one verb further in. What survives every extraction setting is what we
>   **store** of the library, which is ciphertext.

So the data path splits into **two layers**: we use a library for the local
store and hand-roll the file-sync engine. Don't conflate "don't use a sync
framework" with "build everything from scratch."

```
UI ──reads──▶ local store (IndexedDB) ◀──writes── sync engine ──▶ Hono API / R2
   ◀reactive──┘   [LIBRARY: Dexie]                  [HAND-ROLLED]
                                          encrypt before PUT / decrypt after GET
```

### layer 1 — local store + reactivity (use a library)

This is the cache and the source of truth for reads. The UI subscribes to it and
re-renders when sync writes land. **Don't rebuild IndexedDB plumbing by hand.**

- **Dexie** (IndexedDB) — `liveQuery` for reactive reads; simplest and most
  flexible. The preferred default.
- stores **decrypted** entities for fast local reads;
- exposes **reactive queries** so components update when the store changes;
- owns only on-device data — no network concerns leak in here.

Dexie holds:

- decrypted bookmark metadata, tags, lists, settings (the always-resident index);
- decrypted content/page-copy blobs (fetched lazily, on demand);
- the **sync cursor** — a compound `(updatedAt, path)` at or below which every
  op has been applied here, stored as `syncCursorUpdatedAt` + `syncCursorPath`
  (the high-water mark for the next incremental pull, and a claim the engine has
  to be able to back — see _the cursor is a claim_);
- the **pending-ops queue** — local mutations not yet committed to the server
  (this is what makes offline writes durable and drives crash recovery); each
  entry carries the **base `updatedAt`** the edit started from (the path's stored
  server timestamp at edit time), which reconcile uses to tell a clean
  fast-forward from a true conflict (see _a sync cycle_);
- per-path **R2 `updatedAt`** — the server-assigned `LastModified` for each file,
  used by both incremental apply and the fallback comparison (see below).

### layer 2 — sync engine (hand-roll)

Runs at the app/background level, not component-scoped. It owns the sync cursor,
the crypto boundary (encrypt before PUT / decrypt after GET via
`@stxapps/web-crypto`; plaintext never crosses the network), the upload queue
(with retry/backoff and offline handling), and the conflict policy.

It talks to the API through the shared **contract client** (see
[api-contracts.md](./api-contracts.md)). Because it runs outside React it can't
use the `useApiClient()` hook — so the app injects the configured client as
`SyncDeps.api` instead (the same auth-aware `createAuthApiClient` instance the
React tree gets via `ApiClientProvider`: bound to the app's baseUrl with the
bearer token attached — see _assembling the client_ in
[api-contracts.md](./api-contracts.md)). The engine just calls
`deps.api.call(endpoint, input)` — no raw baseUrl, no hooks:

```ts
import { opsListEndpoint } from '@stxapps/shared';
const { ops, oldestUpdatedAt, newestUpdatedAt, hasMore } = await deps.api.call(
  opsListEndpoint,
  // the cursor is the compound (updatedAt, path), not a seq — see *the ops/list endpoint*
  { since: syncCursorUpdatedAt, sincePath: syncCursorPath, limit: 500 },
);
```

Every one of those calls rides a **retrying** client: the engine wraps `deps.api`
in `withRetry` (`@stxapps/shared`), so a `429`/`5xx`/network blip is retried at the
**call** level — keeping already-paged op-log/list work instead of failing the
whole cycle into an error state. It can afford to block on a `Retry-After` because
it runs off the React tree; the in-page extraction drain, which can't block, reuses
the same retry _policy_ by a different _mechanism_ (see
[api-contracts.md](./api-contracts.md) — _transport retry_).

The whole control plane is **four endpoints**, two per resource — `ops` (the
op-log entries) and `files` (the R2 objects):

```
GET  /v1/ops/list      incremental pull: ops since the cursor      (→ the ops/list endpoint)
POST /v1/ops/commit    record committed mutations (batched; checks puts exist, deletes objects) (→ the three flows: push)
GET  /v1/files/list    fallback R2 listing, paginated (download-truth) (→ fallback full sync)
POST /v1/files/sign    mint signed URL(s); op: 'put' | 'get'; via: 'api' | 'r2' (→ authorization & quota)
```

Beside them sits the one data-plane route a sync uses, which moves bytes rather
than metadata and so has no contract (→ _the blob route_):

```
PUT  /v1/files/blob    one object's ciphertext in, authorized by a files/sign token
POST /v1/files/blob    one object's ciphertext out — a browser's read, the token as its body
GET  /v1/files/blob    one object's ciphertext out — a native read, the token in its header
```

**Every endpoint is bounded — never one-path-per-call, never unbounded.** The two
shapes bound differently: the **reads** (`ops/list`, `files/list`) return many and
**paginate** under a `limit`/page size, so a client pages forward with a cursor
rather than pulling an open-ended response; the **writes** (`ops/commit`,
`files/sign`) accept many and **batch** under a `.min(1).max(N)` array, so a
first-sync push of thousands of files is a handful of round trips, and a request
over the cap `400`s at the contract before any work runs (the abuse gate).

> **The two write caps differ, and `ops/commit`'s is a subrequest budget.**
> `files/sign` takes 1000 paths (`MAX_SIGN_PATHS`) — signing is local crypto, one
> subrequest whatever the batch. `ops/commit` takes **500** (`MAX_COMMIT_OPS`),
> because its existence check may `HEAD` every put: one R2 binding call per op in
> the worst case (a sparse batch; a dense one is a few listings, _the three flows:
> push_), on top of the auth
> middleware's D1 read (and renewal write), the bulk delete and the DO RPC, all
> in one invocation. Workers Free — staging's plan — allows **1000 calls to
> Cloudflare services per invocation**, bindings included. At a cap of 1000 a full
> chunk came to 1001+, the last `HEAD` threw, and the commit answered `500` —
> deterministically, so every retry re-uploaded the same chunk and failed the same
> way. **Nothing local catches it**: miniflare enforces no such limit, no spec
> sends a full batch against a real Worker, and production's plan allows 10,000.
> 500 leaves half the budget for whatever the next middleware reads, and halves
> what a failed chunk re-uploads. The listing that now answers a dense batch
> spends less of it, never more: its worst case is the `HEAD`s plus a thirteenth
> as many listing pages (`r2/user-files.ts`, `statMany`). Anything that adds a per-op
> binding call to the commit (a second `HEAD`, a conditional write) spends this
> same budget — lower the cap with it. The client's index put chunk is the smaller of the two caps;
> its content put chunk is smaller still (_a push is chunked_, below).

All four live in `apps/bracemark-api/src/routes/sync.ts` (each behind `requireAuth`).
(One data-plane endpoint sits deliberately OUTSIDE this control plane:
`POST /v1/data/delete-all` wipes the whole namespace — op log, quota map, R2
prefix — in one authed call; other devices then converge through the wiped-log
fallback row below. See [data-lifecycle.md](./data-lifecycle.md).)
The op-plane endpoints (`ops/list`, `ops/commit`) are thin passthroughs to the
user's Durable Object; the file-plane logic — paging R2, the quota gate, the
signer — is in `services/sync.ts`. The shared contracts are in
`@stxapps/shared` (`sync/endpoints.ts`).

`files/sign` is the **only** control-plane endpoint on the hot path of bulk data,
and it's deliberately a thin envelope check (ownership + quota), not a content
gateway: it decides who may move which object, and the bytes then move over the
URL it mints. That URL is one of two kinds.

- **A presign of R2's S3 endpoint** (`r2/presign.ts`) — `via: 'r2'`, or no `via`
  at all, which is what every client shipped before the blob route sends. An
  **AWS SigV4 presign**, because the Workers R2 _binding_ can read/write objects
  from inside the Worker but can't mint a URL the browser can use directly; the
  S3 access keys come from per-env secrets (`R2_*` in `wrangler.jsonc` /
  `lib/env.ts`). A GET is signed with `response-cache-control=no-store`, so R2
  answers the blob with that header and no HTTP cache keeps it
  ([api-contracts.md](./api-contracts.md), _no response is cacheable_).
- **The api's blob route** — `via: 'api'`, which both engines and the iOS share
  extension's upload send. Same grant, faster connection: next section.

#### the blob route

`PUT`/`GET /v1/files/blob` (`routes/blob.ts`) streams one object's ciphertext
between the client and R2 through the bucket binding. It grants exactly what a
presign grants — one object, one method, five minutes for a PUT and an hour for
a GET — and exists because of the connection, not the format. The 2026-10-19
staging readings (_measuring a sync_, below) put a 1,000-link push at ~10
minutes, nearly all of it waiting on sockets:

- **R2's S3 endpoint speaks HTTP/1.1 only** — ALPN refuses `h2` — so a browser
  holds six sockets to it and queues the rest. The engines' fan-out (24 wide then)
  ran six at a time whatever `INDEX_CONCURRENCY` said: content (8 at once) and index
  (24) uploads both measured ~5 PUTs/s, and the median PUT waited 3.4 s for a
  socket. URLSession and OkHttp cap a host at a handful of connections too.
- **Every presigned PUT is CORS-preflighted**, and a preflight is cached per URL.
  Each presigned URL is unique, so every upload paid a second round trip on the
  same six sockets (2,365 preflights in one push).

The api's host is HTTP/2 and HTTP/3, so one connection carries the whole
fan-out. Every transfer has **the same URL**, the object named by a token in its
`Authorization` header, so a browser asks one preflight per two hours (the
api's `maxAge`, [hosting.md](./hosting.md), _cors & frontend↔backend wiring_)
rather than one per blob. Each request is its own Worker invocation making one R2
call, so the Workers limit of six concurrent outgoing connections per invocation
never applies — it is what made the commit slow instead (_the three flows_,
push).

- **The token** (`r2/blob-token.ts`) is an HMAC over `{user, path, method,
expiry}` under a key **derived from `R2_SECRET_ACCESS_KEY`** (HKDF, its own
  label). It is the presign's grant in the api's own format, so the two share a
  root: rotating the R2 key retires both, and there is no second secret to
  provision per env. Checking one is an HMAC and a clock — **no session read**,
  which would cost ~280 ms of D1 per transfer (the `auth` metric); authorization
  was decided at `files/sign`, behind `requireAuth` and the quota gate. As with a
  presign, a revoked session's tokens live out their expiry.
- **A bad or expired token answers `403`**, as R2 answers a bad presign — never
  `401`, which every client reads as a statement about its session
  ([sessions.md](./sessions.md)). An object that is gone answers `404`, which the
  engines skip as an unpulled delete, as they do R2's.
- **The token rides in a header, not the URL**, because the api's invocation log
  stores every request URL whole and a header named `authorization` is the one it
  masks ([api-contracts.md](./api-contracts.md), _a GET's query string reaches the
  request log_). The route's log line is the same for every object.
- **It has its own rate limit.** The `standard` limiter buckets by IP + path and
  this is one path for every object, so it is exempt from it (`app.ts`) and
  carries a per-user `blob` tier (`middleware/rate-limit.ts`) — wide, an abuse
  bound on replaying an hour-long GET token, not a sync's pace. A refusal logs
  the account id, once per account per window, and never the path: the token
  that names the account is masked or unlogged, so without that line a replayer
  who rotates IPs could not be traced to an account.
- **A browser reads with a POST.** Every read is the same URL, and both shapes
  of GET measured badly for it in Chrome against `wrangler dev` (2026-10-19): a
  GET carrying `Authorization` is preflighted, and with `cache: 'no-store'` the
  preflight cache is skipped (673 preflights for 673 reads); without it, the
  HTTP cache holds each read of the one URL behind the last (the pull ran on two
  sockets of six). So web-react's `getBlob` sends the `authorization` value as
  the whole `text/plain` body of a `POST`: a CORS-simple request, never
  preflighted, which no cache stores and the invocation log does not record.
  The same pull then took 3 preflights. expo reads with `GET` and the header —
  native has no CORS, and `File.downloadFileAsync` sends nothing else. PUT keeps
  the header: a PUT is preflighted whatever it carries, and the one URL lets the
  preflight cache answer it (8 preflights for 759 PUTs).

**Both answers stay, and a request for `api` is a preference.** The response is
self-describing — a blob-route URL carries `authorization`, a presign does not —
so the clients send the header when it is there and nothing when it is not. An
api that predates the field strips it and presigns, and the client syncs over R2
as before; a client that predates the field never asks, and is presigned as
before. Neither deploy order breaks a sync, and nothing shipped changes what it
is answered. The presign path, its R2 CORS policy and R2 in the web CSP stay
until no client that sends no `via` is left in use
([hosting.md](./hosting.md)).

**Local dev mints blob-route URLs too**, signed with the `development` env's
committed placeholder secret, so a local run takes the path a deployed client
takes. Only a request with no `via` still gets the older stand-in:
miniflare's emulated R2 has no S3 endpoint to presign, so `files/sign` returns
URLs to an in-Worker blob proxy instead (`r2/local.ts` builds them,
`routes/local-r2.ts` serves them), gated on the placeholder `R2_ACCOUNT_ID` that
only the `development` env carries — staging and production presign R2 directly
and the route 404s there. Both kinds of local URL take their **origin from the
incoming request**, never a constant, because one `wrangler dev` answers on both
`localhost:8787` and the Mac's LAN address at once; see
[device-testing.md](./device-testing.md), _the LAN address is set in exactly one
file_, for the failure a fixed origin produces on a physical phone.

### sync status: two fields, one phase (shared vocabulary)

What the engine is doing surfaces to the UI as **two fields, never one enum**:
`storeStatus` (the gate — can the app render local data at all? durable, stays
`ready` while cycles come and go) and `bgSyncStatus` (the indicator — health of
the current/last background cycle, which fails _without_ leaving `ready`, because
a failed cycle coexists with a usable store — that's the point of local-first).
Every status surface collapses the two into one `SyncPhase` the same way, via
`getSyncPhase`.

That vocabulary — the `StoreStatus` / `BgSyncStatus` / `SyncPhase` types,
`getSyncPhase`, the default `SYNC_PHASE_LABELS`, and `formatSyncedAt` — lives in
**`@stxapps/shared` (`sync/status.ts`)**, not in the platform-web layer. It's pure
data + pure derivation with no React and no browser API, so a client that
re-implements the engine on a non-IndexedDB store (bracemark-expo, on expo-sqlite)
still speaks the same status language and collapses phases identically. The
concrete providers are the platform layer's job: `web-react`'s `SyncProvider`
drives the web engine and produces the two fields; `ExternalSyncProvider` takes
them from an out-of-page context (the browser extension's background worker, via
its `browser.storage` mirror); `expo-react`'s own `SyncProvider`
(`contexts/sync-provider.tsx`) drives the expo engine and produces the two fields
the same way. **Shared owns the vocabulary; each platform owns its producer.**

Labels split the same way. `SYNC_PHASE_LABELS` in shared is the _default_ wording;
each surface layers its own presentation on top of the phase — icons, actions, and
short labels (e.g. the extension popup's cramped `PILL_LABELS` keeps its own
`Synced ✓` / `Error` words next to the "Sync" caption). Those per-surface label
maps stay with their surface — they're presentation, not vocabulary, and have no
second consumer.

### storage layout

**Cloudflare R2** (private bucket; all access via signed URLs). One entity = one
encrypted file. Random ids — never content-derived — so filenames leak nothing:

```
/users/{uid}/links/{id}.enc       ← encrypted link metadata (small, < ~2 KB)
/users/{uid}/files/{id}.enc       ← encrypted content / saved page copy / screenshot
/users/{uid}/tags/{id}.enc        ← encrypted { id, name, updatedAt }
/users/{uid}/lists/{id}.enc       ← encrypted { id, name, updatedAt }
/users/{uid}/pins/{id}.enc        ← encrypted { id, rank, … }; {id} = a pinned link's id
/users/{uid}/extractions/{id}.enc ← encrypted per-link extraction bookkeeping; {id} = the link's id
/users/{uid}/settings/general.enc ← encrypted general user settings
```

A link's metadata references the other files by id; the reference graph lives
**inside** the ciphertext, so the server never sees it. A link is split across two
metadata blobs by **writer** — `links/{id}.enc` (user-authored) and
`extractions/{id}.enc` (machine-derived, same id) — so a background extractor never
rewrites the user's file (see [link-extraction.md](./link-extraction.md)):

```json
// links/{id}.enc — user-authored only
{
  "url": "https://...",
  "tagIds": ["tag_id_1", "tag_id_2"],
  "listId": "list_id_1",
  "customTitle": "my own name for it",   // optional override
  "createdAt": "...",
  "updatedAt": "..."
}
// extractions/{id}.enc — machine-derived (same {id})
{
  "id": "{id}",
  "title": "Some Article",               // discovered og:title
  "imageId": "{id}.enc",                 // → files/ preview blob
  "pageCopyId": "{id}.enc",           // → files/ page-copy blob
  "facets": { "titleImage": { "status": "done" } },
  "createdAt": "...",
  "updatedAt": "..."
}
```

**Per-user op log** lives in a **Cloudflare Durable Object** (one DO per user,
addressed by `idFromName(userId)`), backed by the DO's SQLite. See
`apps/bracemark-api/src/do/user-data.ts` and `do/repositories/op-logs.ts`. Each row is
`{ seq, op: 'put' | 'delete', path, updated_at }`, where **`updated_at` is
R2's `LastModified`** for that path (read via a `HEAD` at commit — see _push_),
and the **client's sync cursor is that timestamp**, never `seq`.

`seq` (`INTEGER PRIMARY KEY AUTOINCREMENT`) stays **internal**: it orders rows
that share a millisecond and drives compaction, but it never goes over the wire.
Keeping the cursor on R2's clock rather than on `seq` is deliberate — a sequence
number is only meaningful inside one DO's lifetime and **cannot be reconstructed
from an R2 listing**, so a rebuilt log would strand every cursor it had ever
issued. An R2 timestamp survives that: a log rebuilt from a listing stamps its
rows with the same `LastModified` values, so a cursor issued before the rebuild
still divides applied from unapplied where it did. A DO rebuild or seq reset
therefore can't invalidate a client cursor, and a wiped log is rebuildable from
R2. (What the shared clock does NOT buy is a cursor read off a listing: the
newest `LastModified` a client happens to list is not one, though this section
used to say it was — _the cursor is a claim_.)

### schema changes — shipped, so append-only on every side

Three client shapes above can move. Until the first release they were
greenfield: Dexie's `version(1)` (`packages/web-react/src/data/db.ts`), the
expo-sqlite DDL (`packages/expo-react/src/data/db.ts`) and the R2 payload shapes
(`packages/shared/src/sync/`) changed by **rewriting them**. You changed the
shape, recreated the dev database (deleted the app or cleared its data) and
added no migration step, because compatibility with a past no user had was cost
with no beneficiary.

**⚠ That regime ended with the first release.** The shapes as they shipped are
now version 1 on users' devices, and "delete the app, clear its data" is no
longer a dev chore. It deletes a library that, with the server unreachable or
gone, exists nowhere else ([offline-mode.md](./offline-mode.md), _the promise_).
The three client shapes now change on different terms:

- **Dexie (`bracemark-data`) and the raw session database
  (`bracemark-session`).** Append `version(N)` (with an `upgrade()` for any
  data reshape); never edit a shipped version, and bump `DATA_DB_VERSION`
  (`db.ts`) with every Dexie `version(N)` — the newer-schema check compares
  against it. The `versionchange` handler every tab needs is in place on both
  databases (`data/update-required.ts`): the event fires in the _old_ tab, so it
  had to ship before the first `version(2)`, and it has. The mechanics and the
  failure modes are in [offline-mode.md](./offline-mode.md), _version skew_.
- **expo-sqlite.** The idempotent DDL in `db.ts` is the shipped version 1.
  Every change after it is a numbered migration keyed on `PRAGMA user_version`,
  run on open before first use, append-only like the server's. Never edit a
  shipped statement. One process opens the database at a time (the iOS share
  extension writes its outbox file, not the database;
  [share-sheet.md](./share-sheet.md)), so there's no multi-tab counterpart to
  `versionchange`. No migration exists yet, so there's no runner yet either.
  It lands with the first migration. Nothing sets `user_version` today, so
  every database the first release created reads `0`, and the runner has to
  treat `0` as the shipped schema, not as an empty database.
- **R2 payloads** are already built to cross versions. Every entity is a
  `z.looseObject` (`packages/shared/src/sync/entities.ts`), so an older client
  passes fields it doesn't know through unchanged, and the blob frame's version
  byte makes an unknown layout fail loudly rather than misread
  ([crypto boundary](#crypto-boundary--what-the-server-still-learns)). Since
  the first release, what has changed is only the licence to _rewrite_ a shape: fields are
  added, never renamed or repurposed, because a device that last synced a year
  ago will still write the old name back.

**`bracemark-api` is deployed, and nothing at the call site says so.** Its two
SERVER schemas have left that regime:
`apps/bracemark-api/src/db/migrations/<role>/0001_init.sql` is recorded as applied
in every live D1 and `wrangler` will never re-run it, and a DO already past
`schema_version` 1 never re-runs `MIGRATIONS[0]` in `src/do/user-data.ts`. Editing
either in place is silent in the worst way — a fresh or local database gets the
new shape, every deployed one keeps the old, and the apply still prints ✅.
**Append**: a new `0002_*.sql`, folded into `db/schemas/<role>.sql` so a fresh DB
matches a migrated one; or a new `MIGRATIONS` entry, never an edit to a shipped
one. Folding a change back into the init is only correct if you also drop and
re-provision every deployed database, deliberately. The two READMEs are the rule's
home and carry the mechanics:
[`src/db/migrations/README.md`](../apps/bracemark-api/src/db/migrations/README.md)
and [`src/do/README.md`](../apps/bracemark-api/src/do/README.md); applying one to
a real tier is [hosting.md](./hosting.md), _deploying the workers_.

### source of truth: R2 is truth, the op log is an accelerator

**R2 is the source of truth. The op log is a derived accelerator that may be
empty.** This one sentence resolves most of the edge cases below: if the op log
is wiped or compacted, clients fall back to listing R2 and lose nothing but
speed.

The op log exists only to make incremental sync fast (pull "what changed since
timestamp T" instead of listing every file). It is safe to compact aggressively —
**keep the last 30 days or the last 10 000 ops per user, whichever is more** —
and safe to lose entirely.

The critical invariant, and the reason the commit protocol is ordered the way it
is:

> **The op log may lag R2, but must never point ahead of it.**

- `object-without-op` (an R2 object with no op-log entry — e.g. a commit died
  after the R2 PUT) is **tolerable**: it is invisible to incremental pull but
  reconciled by the fallback list.
- `op-without-object` (an op-log entry whose R2 object doesn't exist) is **much
  worse**: every client that pulls that op tries to download a 404.

That asymmetry is exactly why the op-log append runs **after** the R2 write
succeeds (see the `commitOps` comment in `user-data.ts`).

### data model: everything is one entity per file

Bookmarks, content blobs, **tags, lists, and settings are all just files**, and
all sync through the identical code path: last-writer-wins per file, `put` /
`delete` ops, the same upload queue. There is no special "merge by key" logic for
tag/list names.

- **Tags and lists** are stored one per file (`tags/{id}.enc`,
  `lists/{id}.enc`), each holding `{ id, name, updatedAt }`. Bookmark metadata
  stores only the **ids**, so renaming a tag/list rewrites one small file and
  touches no bookmarks. Rename = `put`; delete = `delete`. This is what lets two
  devices rename two _different_ tags concurrently without clobbering each other
  — a single shared `tags.enc` file under LWW could not.
- **Pins** ("pin a link to the top") are stored one per file (`pins/{id}.enc`,
  where `{id}` is the pinned link's id), each holding `{ id, rank, … }`. A pin is
  the same LWW-isolation move applied to a per-link flag: keeping pin state in its
  own file means pinning/unpinning/reordering writes only the pin and never
  clobbers a concurrent edit to the link's `links/{id}.enc` blob (and vice-versa) —
  a `pinned` field _inside_ metadata could not. `rank` is a fractional index (the
  same scheme as tag/list order) so reordering a pin rewrites only that one pin
  (the one exception, for lists and tags as well, is a slot between two **tied**
  ranks, which re-keys the tied neighbour too — `editors.md`, _a `move` is one
  write too_).
  Pin = `put`; unpin = `delete`. No `listId` in the pin: the link already records
  its list, so a pin floats the link to the top of every view it appears in, and a
  pin whose link is gone is just another dangling id the read layer skips.
- **Extractions** ("fill in a saved link's title/image/screenshot/page-copy") are
  stored one per link (`extractions/{id}.enc`, where `{id}` is the link's id). This
  is the **machine-written half** of a link, holding **both** the extracted display
  result (`title`, `imageId`, `pageCopyId`, `screenshotId`) **and** the
  per-facet bookkeeping (`{ status, tier, attempts, … }`). It's a stronger
  LWW-isolation move than pins': the split is **by writer**, so a background
  extractor writes only this file and can **never** read-merge-write the user's
  `links/{id}.enc` and clobber a concurrent list/tag/title edit (the one
  unrecoverable race the old "backfill display into `links/`" layout risked). Races
  inside `extractions/` are between two extraction writes only — idempotent,
  self-healing. The UI joins the two blobs to render a row (`customTitle ??
extraction.title ?? host(url)`). Written by client extractors (the browser
  extension, bracemark-expo, the web app orchestrating `bracemark-extractor` or an
  import), never by `bracemark-api`, which stays a blind sync broker. The work loop
  is a **query**, not
  a queue object: a link with no `done` `titleImage` facet (no `extractions/` file,
  or one not yet extracted) is pending. See
  [link-extraction.md](./link-extraction.md) for the entity and the privacy stance.
- **Settings use a fixed `settings/` namespace** (`settings/general.enc` today).
  Unlike every other file — a random id (see _storage layout_) — these are
  **well-known paths** baked into client code, the one non-random-id family.
  Splitting by concern under `settings/` rather than one monolithic `settings.enc`
  is the same LWW-isolation move as tags/lists: a separately-written concern can
  later get its own `settings/<concern>.enc` so an unrelated settings edit on
  another device can't clobber it. Because the paths are fixed, **adding** a new
  `settings/<concern>.enc` needs no migration; renaming an existing one would.
- **Dangling ids are normal and must be tolerated.** Deleting `tags/{id}.enc`
  leaves bookmark metadata that still lists that id; a content file referenced by
  metadata may not be downloaded yet. In both cases the UI must **skip the
  unknown/absent reference and render the rest**, never error. No referential
  cleanup is required — LWW plus tolerant rendering covers it.
- **Metadata vs. content.** Metadata is small (`< ~2 KB`) and always synced into
  the local index; content/page copies download **lazily, never on first sync**. The
  list-view fields live in metadata-class blobs that are all eagerly synced — the
  URL, tags, list, note, and overrides in `links/`, and the extracted title/image
  in `extractions/` — so the **whole library is browsable and searchable offline**
  after first sync (the view joins the two by id), only heavy media is deferred. Keep large fields (long descriptions, long-form
  notes, thumbnails) **out of metadata** — store them as separate `files/{id}.enc`;
  never inline a thumbnail, or you blow the `< 2 KB` budget. A **short** user note
  is the deliberate exception: it's a **capped** inline field (`linkSchema.note`,
  ≤ 500 chars) precisely so it renders in the list view and stays searchable
  offline — the cap is what keeps it inside the budget; anything longer becomes a
  `files/{id}.enc` (`noteId`, deferred). Two lazy triggers:
  **viewport/scroll** fetches per-row media (thumbnail/screenshot) as rows come
  into view (prefetch slightly ahead); **open** fetches the full saved page copy.
  Each fetched blob is decrypted once and **cached in Dexie**, so re-views are
  instant and offline. That cache write is a **compare-and-set on the `updatedAt`
  the fetch started from**: a lazy fetch spans network round trips, and a sync
  pull that lands inside one restamps the path to a newer version (dropping the
  cached bytes). Writing the older blob under that new stamp would pin **stale
  content forever** — the staleness skip only re-downloads when the server stamp
  moves _again_, and it just did. Losing the race simply skips the cache: the
  caller still gets the bytes it asked for, and the next call fetches the new
  version. expo stores the plaintext as a file rather than a column, so there the
  CAS guards the `has_data_file` flag and a lost race deletes the stale file and
  reports "not available" instead. The one tradeoff: a never-opened page copy
  isn't available offline (see _deferred_ — offline pinning).
- **Plaintext typing: the namespace says what's inside, never the blob.** On the
  wire every object is the same opaque encrypted frame (see _crypto boundary —
  blob wire format_); nothing about an R2 object distinguishes JSON from an
  image. The decrypted bytes are typed by **convention baked into the client**:
  the index namespaces — `links/`, `tags/`, `lists/`, `pins/`, `extractions/`,
  `settings/` — are
  UTF-8 JSON (decode, then `JSON.parse`), while `files/` is raw content whose meaning
  comes from the **metadata field that references it** — `pageCopy` means an
  HTML page copy, a `screenshot`/`thumbnail` field means an image. The client only
  ever reaches a content blob _through_ such a field, so it knows what it is
  about to decrypt before it even signs the GET. Where one field may hold
  several formats (PNG vs. WebP, raw HTML vs. a single-file bundle), store the
  type beside the id **inside the metadata's ciphertext** — e.g.
  `"screenshot": { "id": "{id}.enc", "type": "image/webp" }` — a per-field
  metadata-schema decision that touches nothing in the sync engine, the blob
  frame, or the server. These plaintext JSON shapes are a **cross-platform
  contract** like the blob frame itself (every platform must read/write the
  same JSON), so their types/schemas belong in `@stxapps/shared`. The **sync and
  crypto path** stays fully agnostic: it moves opaque ciphertext, the engine
  never imports a schema, and the Dexie record's authoritative payload is still
  just path + `updatedAt` + raw decrypted bytes. The **local store** goes one
  step further than the wire, though — to query an in-blob field (filter links by
  list, order by edit time) without reading and `JSON.parse`-ing the whole
  library on every reactive tick, it indexes a few list-view fields. Those
  index columns are **derived, not authoritative**: a single projector
  (`web-react` `data/projection.ts` `toItemRecord`) decodes the bytes and lifts
  out the queryable fields, and **every** write into the store funnels through
  it, so the columns are written in the same record `put` as the bytes and can
  never drift from them (no second table, no cross-table transaction). The
  result: the wire is payload-blind, schema knowledge lives in exactly two
  places (the write-edge projector and the read layer, sharing one `parseBlob`),
  and turning a record into a typed bookmark/tag/list entity is still a read
  layer **above** sync. The same division settles **identity**: an entity is the
  one its path names, and an `id` inside the plaintext (lists, tags, pins and
  extractions carry one) is a copy for self-containment. Sync stores what
  arrives without opening it, so nothing below the read layer can make that copy
  agree with the path, and the read layer is where it has to be set aside —
  `idFromPath` (`sync/paths.ts`) is the way to an id. `readLists`/`readTags`/
  `readPins` apply it to every list, tag and pin they return, a link's id has
  always come from its path, and an extraction is fetched by path
  ([data-lifecycle.md](./data-lifecycle.md), _a list's identity is its path_).

### the three flows

**1. First sync (after sign-in).** Pull the full set of metadata/tag/list paths,
download + decrypt each, build the local index. Content/page copies are _not_
downloaded here — they come on demand. For 5 000 bookmarks at ~500 bytes of
metadata each that's ~2.5 MB — manageable. Set the cursor to the **op log's
newest stamp, read before the listing** — one `ops/list` call with `limit=1`,
ahead of the first `files/list` page — and NOT to the newest stamp among the
files listed, which is what this flow used to do (_the cursor is a claim_). The
fallback full sync ends on the same value.

A first sync also **drops what the listing does not show**: a path in the local
store, absent from the listing, with no op queued. On a fresh sign-in the store
is empty and that is one read of nothing. The case is a **retry** — a pull that
died partway left what it had stored, and the cursor above is only a true claim
if the listing is reconciled in both directions (_the cursor is a claim_, _the
claim covers what the listing does not show_).

This is the only flow that **blocks the UI**, so it is also the only one that
**reports progress**. `runInitialSync` takes an optional `onProgress(done, total)`
— a parameter, not a `SyncDeps` field, because the providers build one `deps` and
hand it to both flows, and a background cycle has no blocked screen waiting on a
count. The order matters: the listing reports **nothing** (there is no
denominator until it returns, and inventing one is just a fake progress bar),
then `storeDownloads` emits `(0, n)` the moment it knows `n`, then one tick per
entry. `n` is the count of **index** blobs actually being fetched — after the
selective-sync filter and after the staleness skip, and never including `files/`
content, whose blobs aren't downloaded here at all. So the number is a fact
rather than an estimate, an interrupted run's retry counts only the remainder it
still has to do, and — because the tick sits in a `finally` — an entry skipped
for a mid-pull 404 still counts, which is what keeps the counter from stalling
one short of its own total. The shape of the type and the wording of the label
(`InitialSyncProgress`, `initialSyncProgressLabel`) live in `@stxapps/shared`, so
both gates say the same thing; the **throttling** is the providers' job, not the
engine's — the engine is React-free and also runs in the browser extension's
service worker, which has no renders to schedule. What the two gates then draw
with it is [accessibility.md](./accessibility.md), _the first-sync counter_.

**2. Incremental sync (next visit).** Call `GET /v1/ops/list` with the cursor,
get the ops whose `updatedAt` is newer than the cursor, apply them (download +
decrypt + store for `put`, remove for `delete`), and advance the cursor to the
**newest `updatedAt` in the response** (not the server's current newest — anything
that lands mid-sync simply carries a later `updatedAt` and is caught next time;
this is why the race in older drafts is a non-issue). That promise is not free:
it is what the **commit clamp** under _push_ enforces, since a put's stamp is
minted at PUT time and could otherwise land behind a cursor already issued. And
it is kept only because the cursor moves to that op and no further: a cycle that
also pushes does NOT add its own commits' stamps, which sit above ops it never
listed — see _the cursor is a claim_.

**3. Push (new / edited / deleted entity).** Write to the local store first and
enqueue the mutation in the pending-ops queue, then drain the queue:

```
create / edit a bookmark:  upload content files first, metadata file LAST
delete a bookmark:         delete metadata first, then content files
```

The commit protocol (3 round-trips), **batched** across files — `files/sign` and
`ops/commit` each take an array (up to 1000 and 500), so a multi-file create or a
first-sync push is a handful of round trips, not one per file:

1. `POST /v1/files/sign` with `{ op: 'put', paths: [...], via: 'api' }` to mint
   signed upload URL(s) (the Worker verifies each path is under
   `/users/{authedUid}/` and checks quota — see _authorization & quota_);
2. encrypt and PUT each blob over its signed URL — the blob route, or R2 directly
   (_the blob route_);
3. `POST /v1/ops/commit` with `{ ops: [{ op, path }, …] }`; for each `put` the
   Worker **checks the object in R2** — which both confirms it exists and reads
   R2's authoritative `LastModified` — records the op with that timestamp (the DO's
   `commitOps`, which also stores R2's reported object size in the per-user quota
   map). One DO RPC then writes the whole batch. The Worker returns
   `{ results: [{ path, updatedAt }, …], failed: [{ path, reason }, …] }` —
   `results` for the committed ops, `failed` for the refused ones. The check does
   double duty: existence check _and_ the single clock that incremental and
   fallback both compare against.

**The existence check is a listing where the batch is dense and a `HEAD` where it
is sparse** (`r2/user-files.ts`, `statMany`). It used to be a `HEAD` per put,
fanned out in parallel — but a Worker invocation runs at most **six** outgoing
calls at once that are waiting on their response headers, and a `HEAD` is nothing
but headers, so 500 of them ran six at a time: **25.6 s per full index chunk** on
staging, a fifth of a 1,000-link push. An R2 listing answers up to a thousand
keys per call, in key order, so the batch is sorted, each namespace walked page
by page from its first unanswered key (`startAfter`), and a page answers every
batch key up to its last key: listed is present, unlisted is absent. The same
facts from the same strongly consistent bucket, so the invariant below holds
exactly as it did. Under 12 puts it `HEAD`s outright, and a page that answers
fewer than 13 keys hands the rest of its namespace to `HEAD`s — the few-edits
case, where a page would answer one. The 13 is R2's price list, not a speed
guess: a listing is a Class A operation and a `HEAD` Class B, so one page costs
what 12.5 `HEAD`s do, and a page kept is never the dearer way to answer its keys
(at most one page per namespace per commit is spent finding out). Both
thresholds are starting points; the commit's Server-Timing (`r2-stat` wall beside
the `r2-list` and `r2-head` sums) is what to tune them against.

A `put` whose R2 object is **missing** (its PUT never landed, or died before the
commit) is **not recorded — logging it would break the op-without-object
invariant** — and is reported in `failed` with `reason: 'no_object'`. So every op
the client sent gets an **explicit per-path outcome** (a path in neither `results`
nor `failed` is a server bug the client can detect), rather than inferring failure
from absence. On `no_object` the client re-PUTs + re-commits the gap next drain;
commit is idempotent, so a retry costs at most one redundant download. `reason` is
a typed enum so the deferred R2-conditional-write upgrade can add a `'stale'`
outcome (client action: re-_pull_ then retry — a different branch). A `delete`
always commits — and its R2 object is removed by the **Worker itself** at commit
(one bulk binding call per batch; `files/sign` mints only `put`/`get` URLs, so the
client never DELETEs R2 directly). R2 first, log last, the same direction as puts:
a commit that dies between the object delete and the log append leaves an absent
object with no op — invisible to incremental pull, healed by the fallback — and a
retried delete of an absent key is a no-op.

The pending-ops entry stays in the queue until its path appears in step 3's
`results` (a `failed` path stays queued for retry). **Crash recovery falls out of this for free:** if the client dies
between the R2 PUT and the commit, the entry is still queued; on retry it re-PUTs
(harmless — a fresh IV, but R2 PUTs are atomic so it just overwrites with
equivalent ciphertext) and commits. **Commit is idempotent in effect:**
re-committing a path appends another op row (the log isn't deduped on write), but
applying any op just means "re-download the latest version of that path," so a
duplicate costs one redundant download and nothing else — server-side op
coalescing (see _deferred_) trims the extra rows later. Never fail a commit on a
duplicate path.

> **A push is chunked, and a failed upload costs its own op — never its chunk.**
> One pipeline pass signs, uploads, and commits a **single chunk** rather than
> signing everything up front: that keeps each presigned PUT's mint-to-PUT
> latency inside its **own** chunk's upload window. The chunk size is per blob
> kind. An **index** chunk is the smaller of the `files/sign` and `ops/commit`
> caps (500): KB-sized blobs drain it in seconds, far under the 5-minute TTL, and
> a smaller chunk would only spend more of the `tight` rate limit (10 calls per
> 10 s per user and per path, so `files/sign` and `ops/commit` each have a bucket;
> every chunk spends one call of each). A `files/` **content** chunk is **100**,
> because the chunk is also the step the pending count moves in — its ops leave
> the queue only when it commits — and 500 MB-sized blobs took minutes on an
> ordinary uplink, with "N changes waiting to sync" frozen throughout. 100 is
> about a minute at 1 MB a blob over 10 Mbps. Small content goes at the full
> fan-out (_measuring a sync_), so a chunk of it is two or three rounds — but a
> chunk still spends one sign and one commit, and only a chunk under a second long
> would reach either bucket's limit.
>
> **A chunk's commit runs beside the next chunk's sign and upload**, one commit
> in flight at most. The commit is a round trip of its own (~1.6 s on staging,
> mostly R2 answering the existence check), and run in line it left the fan-out
> idle between every pair of chunks. Overlapped, the order still holds: each
> commit starts once the one before has landed, a failed one stops the set, the
> pending count steps down per chunk at most one chunk behind, and a set — so a
> phase — ends only when its last commit has. The next chunk's URLs are minted
> after this chunk's upload ended, so the mint-to-PUT window grows by nothing.
> What it loosens is the quota gate's view: `files/sign` reads usage the commits
> record, and the gate already charges a batch's growth to the next one (a cost
> backstop, `lib/quota.ts`), so the overshoot it allows grows from one chunk to two.
>
> Even at 100 a content chunk can outlive the TTL on a slow enough uplink, so the
> expiry is absorbed **per blob**: an expired-URL PUT (R2 answers 403) fails only
> its own op, the chunk still commits
> the blobs that **did** land, and the rest re-sign next drain under fresh URLs.
> Letting the failure escape and abort the whole chunk instead made a chunk too
> big for one TTL window a **deterministic livelock** — every retry restarted the
> same too-big chunk and re-expired at the same point, so the push never advanced.
> Absorbing it per blob makes the remainder **shrink every cycle**.
>
> Three rules keep that from becoming a correctness hole:
>
> - **A failed op is left queued but kept OUT of the commit.** Unlike an unsigned
>   path there is nothing to gain from asking the server to `HEAD` an object we
>   know we never sent — on a large failed chunk that is up to a chunk's worth
>   (100 or 500) of guaranteed `no_object` entries per cycle.
> - **The metadata phase is HELD for the rest of the cycle if any content upload
>   failed** — otherwise a puller could land metadata whose content `404`s, the
>   exact breach the content-before-metadata order exists to prevent. Held
>   _wholesale_ because the engine is schema-blind: it cannot tell which metadata
>   is safe. The held ops just stay queued and the next drain retries both halves
>   in order. **Content the quota gate refused holds it the same way**, without
>   asking the gate again. That ask would usually be refused too, since the gate
>   reads usage and usage only grew, but a delete committed by another device or
>   a purchase that raised the ceiling can land between the two sign calls and
>   let the metadata through alone. The held ops count toward `blockedCount`.
> - **The cycle still REJECTS**, after the phases rather than before them — so it
>   keeps the progress it made, while the caller's error branch (`bgSyncStatus
'error'`, a scheduled retry) still fires. Reporting a clean `idle` over an
>   unpushed edit would leave the user nothing to notice and nothing to retry.
>
> This is also why `mapLimit`'s own failure policy is fail-fast (stop feeding work
> into a failing cycle): the upload loop catches **per op** so its transient
> failures never reach the pool at all. Coverage:
> `packages/shared/src/async/pool.spec.ts`,
> `packages/web-react/src/sync/engine.spec.ts`.

The store records the **R2 `LastModified` returned by commit** as the file's
`updatedAt` — never the local clock — and that is the stamp's only use: it is
not folded into the sync cursor (_the cursor is a claim_). Every `put`
is therefore stamped on R2's clock — the same value the client stores locally and
the fallback listing reads back — so there is no cross-device skew to reconcile
for any write that has a surviving object. (A `delete` op has no surviving object
to `HEAD`, so its `updated_at` is the **deletion commit time** — a `deletedAt` —
on the Worker's clock rather than R2's; the `updated_at` column thus mixes the two
clocks. That mismatch is harmless, but **not** because a deleted path is never
put again — this paragraph used to say a path's life is only ever
`put`…`put`…`delete`, and that is false. It is true of a link, a tag, a list or a
`files/` blob, whose path is a random id minted per record. It is not true of
`pins/{id}.enc` and `extractions/{id}.enc`, which are keyed by their **link's**
id: unpin-then-pin and a re-extraction both `put` the path a `delete` just
vacated, in ordinary use. And local-wins reconcile re-`put`s a path whose
`delete` another device already committed, deliberately — keeping the unsynced
edit is the point. What makes the two clocks safe to mix is the **commit clamp**
below: the log orders a path's ops by the order they were **committed**, never by
comparing a Worker stamp against an R2 one, so a re-put always sorts after the
delete it follows however far the clocks disagree. Anything that needs a path to
be immutable has to say what it does about those two namespaces.)

> **The commit clamp: an appended op is always strictly newer than any cursor the
> log could have issued.** A put's `updatedAt` is minted at **PUT** time (R2's
> `LastModified`) but only becomes visible at **commit** time, and the two can be
> minutes apart — the rest of a chunk's uploads, a retry backoff, a slow uplink on
> a big `files/` blob. So a slow committer can arrive carrying a stamp **older
> than ops already in the log**: behind a cursor another client (or its own
> earlier commit) has already advanced past, in a keyset pull that will therefore
> **never see it**. That is silent cross-device staleness with no error and
> nothing to retry — and it is exactly the hole under flow 2's promise that
> "anything that lands mid-sync simply carries a later `updatedAt`". `commitOps`
> closes it by recording any such entry at **`MAX(updated_at) + 1`** instead, and
> **returning the lifted stamp** — it is what the committing client stores on the
> record, so client and log never disagree about it.
>
> The consequences are benign by construction. Per-path order is preserved: the
> prior op for a path is already in the log, so the clamp only ever lifts the new
> one **above** it. Within one batch the shared floor is fine: the batch commits
> atomically under the serialized DO, so a puller sees all of it or none, and the
> `(updatedAt, path)` tiebreak orders its ties. A stamp nudged past R2's real
> `LastModified` costs **one redundant, idempotent re-download** on a client that
> stored the object from a LISTING, at R2's own stamp, and then meets the lifted
> op. The committer stores the lifted stamp itself, so a later fallback — which
> downloads only what is listed NEWER than the local copy — passes over the path.
> That is also the one place a lift could hide something, and only from a
> fallback: an object rewritten so soon after a lifted commit that its
> `LastModified` is still not past the lifted stamp, which needs the log's stamps
> to be running ahead of R2's clock — by the skew between the Worker's clock and
> R2's, or a run of `+ 1`s, so milliseconds. An incremental pull is driven by the
> rewrite's op, which the clamp puts above the lifted stamp whatever R2 says; a
> fallback has only the listing to compare, and a rewrite with NO op (a commit
> that died) has only the fallback to find it. The next commit to the path
> clears it. An in-order commit is untouched — the clamp only engages on the
> race.
>
> **Strictly above, and the `+ 1` is load-bearing.** An entry that arrives
> stamped exactly at the log's newest is lifted too, so nothing appended later
> ever TIES with a stamp already in the log. That is what lets a client take
> `newestUpdatedAt` as its cursor before it lists R2 (a first sync, a fallback):
> everything at or below it is already committed, and nothing that comes later
> can sit at it or under it. Coverage for both halves:
> `apps/bracemark-api/src/do/user-data.spec.ts`.
>
> The clamp orders what is **appended**; it cannot make a client list a range
> it skipped. That half is the client's, and it is why a cursor only ever moves
> over ops a cycle listed — _the cursor is a claim_.

### the ops/list endpoint

The cursor is a **timestamp — R2's `LastModified`** — not a sequence number (see
_storage layout_ for why `seq` stays internal). Strictly it is the **compound key
`(updatedAt, path)`**, so the wire cursor is the pair `since` + `sincePath` (see
_Cursor precision & pagination_ below). The pull endpoint returns the ops newer
than the cursor plus the retained-range bounds, so the client can tell incremental
from fallback:

```
GET /v1/ops/list?since=2026-04-13T10:00:00.000Z&sincePath=links/l_abc.enc&limit=500
→ {
    ops: [{ op, path, updatedAt }, ...],   // ordered by (updatedAt, path)
    oldestUpdatedAt,   // min updated_at still retained — null on an empty log
    newestUpdatedAt,   // max updated_at ever recorded — null on an empty log
    hasMore,
  }
```

`updatedAt` is R2's `LastModified` for a `put` (recorded via the commit `HEAD`)
and the deletion commit time for a `delete` (no surviving object — see _push_).
Both bounds are plain aggregates over the retained rows — `MIN(updated_at)` and
`MAX(updated_at)` — with **no high-water-mark table needed** (unlike a seq):
compaction trims oldest-first and never removes the newest row, so
`MAX(updated_at)` is always the true newest-ever. A never-written log reports
`oldestUpdatedAt = newestUpdatedAt = null`.

Routing:

| condition                                   | meaning                                                           | action                                          |
| ------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------- |
| `since` unset (never synced)                | new device / new account                                          | **first sync** (list R2; empty ⇒ nothing to do) |
| `since` set but bounds `null`               | cursor exists, log empty — wiped/reset beneath a returning client | **fallback** sync                               |
| `since > newestUpdatedAt`                   | cursor ahead of the log — log was reset                           | **fallback** sync                               |
| `since < oldestUpdatedAt`                   | ops before the cursor were compacted                              | **fallback** sync                               |
| `oldestUpdatedAt ≤ since ≤ newestUpdatedAt` | normal — run the keyset query                                     | apply `ops` (empty result ⇒ already up to date) |

What these rows encode — all because **an empty op log never means "no data";
only R2 can answer that** (the log is a disposable accelerator, rebuildable from
an R2 listing):

- **No cursor ⇒ first/full sync** (flow #1 — list R2), never the incremental
  path. So "nothing to do" is only reached after actually listing R2 and finding
  it empty — a wiped log can't be mistaken for a new account.
- **A cursor against `null` bounds ⇒ fallback.** A client with a cursor proves it
  synced before, so an empty log (both bounds `null`) means the log was wiped or
  reset under it — re-list R2 rather than reporting "up to date." This is the
  same wiped-log case as the row below, reached when compaction (or a rebuild)
  emptied the log entirely rather than just trimming past the cursor.
- **`oldestUpdatedAt ≤ since ≤ newestUpdatedAt` is inclusive at the top on
  purpose.** `since == newestUpdatedAt` is _not_ a separate "up to date" branch:
  because the cursor is the compound `(updatedAt, path)`, the newest millisecond
  can still hold ops with a higher `path` tiebreak the client hasn't seen. So the
  keyset query always runs at the boundary; an empty result is what means "already
  up to date," not the timestamp comparison.
- **`since > newestUpdatedAt` ⇒ fallback**, not "up to date." A healthy server's
  newest timestamp is always ≥ any cursor it issued (the client only stores
  cursors the server minted, and compaction never trims the newest), so a cursor
  ahead of it can't arise in steady state. It means the op log was reset, rebuilt,
  or restored from an older backup beneath a returning client — an infra event the
  disposable-log design _expects_, not necessarily a client bug. Either way,
  re-list R2.

**Cursor precision & pagination.** Because several files can share a millisecond,
the cursor is the compound key `(updatedAt, path)` and the pull is a **keyset**
scan: `WHERE (updated_at, path) > (since, sincePath)` ordered by
`(updated_at, path)`. Both halves go over the wire — the `since` _and_ `sincePath`
query params above — because without the `path` tiebreak a single millisecond
holding more than `limit` ops could never be paged past, and the
`since == newestUpdatedAt` boundary couldn't distinguish "consumed every op at
that ms" from "more remain with a higher path." A long-offline client pages
forward by advancing **both** params to the last op's `(updatedAt, path)` while
`hasMore` is true. (`sincePath` is omitted while the cursor has no path half —
the seeded-new-account `(0, '')`, and the `(newestUpdatedAt, '')` a first sync or
a fallback ends on; the server treats a missing `sincePath` as the low sentinel,
so the scan includes every op at that millisecond.) This keyset query and the `oldestUpdatedAt` / `newestUpdatedAt`
bounds live in `op-logs.ts` (`listSince` keysets on `(updated_at, path)`;
`bounds()` returns `MIN`/`MAX(updated_at)`), surfaced to the route by the DO's
`listOps` RPC in `user-data.ts`. `seq` stays internal — it orders ties and drives
compaction, but never goes over the wire.

> R2's `LastModified` arrives as `.head().uploaded` (a `Date`); the op log stores
> `uploaded.getTime()` — epoch **milliseconds**. The `(updatedAt, path)` keyset
> stays correct at any granularity, but ms keeps ties (and the pagination through
> them) rare.

### a sync cycle: reconcile, then push, then pull

Flows 2 and 3 are building blocks; a live online session with local changes runs
both, and the order matters. **Reconcile first** — you can't safely push before
you know what the server changed, or you'd blind-overwrite a remote edit you never
saw.

1. **Pull the op list** (flow 2's request — metadata only: `{ op, path, updatedAt }`
   per changed path, _not_ the blobs).
2. **Reconcile** the pulled ops against the pending-ops queue, partitioning every
   touched path by who changed it. Each pending op carries the **base `updatedAt`**
   it was edited from (the path's stored server timestamp at edit time):
   - **server-only** (no pending op for the path) → **download**;
   - **local-only** (no server op for the path) → **upload**;
   - **both, server `updatedAt` == base** → the server didn't really change it
     (often your own earlier commit echoing back) → **upload** (clean
     fast-forward);
   - **both, server `updatedAt` > base** → a **true conflict**: both sides changed
     the file since your base. Resolve by the LWW policy (see _conflict policy_);
     the accepted outcome today is that one side's edit is dropped silently, and
     the deferred conditional-write upgrade turns this into a detected `412` +
     re-pull. _Which_ side wins — local (upload) vs server (download) — is an open
     product call (see _deferred_); **the shipped engine resolves local-wins**, so
     today every pending op lands in the upload set (which collapses the two
     "both" rows — the base comparison earns its keep when conditional writes
     land and `stale` needs the fast-forward/conflict distinction).
     The output is two **disjoint** sets: paths to upload, paths to download.
3. **Push** the upload set (flow 3 — meta-last; commit returns each new server
   `updatedAt`).
4. **Pull** the download set's blobs (decrypt, store; content stays lazy).
5. Advance the cursor to the last op **listed in step 1**, and no further. Your
   own just-committed uploads are NOT folded in — the step used to add them, "so
   the next cycle doesn't re-fetch them", and that moved the cursor past ops
   another client had committed in the meantime. The next cycle lists them back
   instead, at the cost of an op row each and no transfer (_the cursor is a
   claim_).

Because step 2 resolves each conflicting path to exactly one side, the upload and
download sets never overlap — so steps 3 and 4 are order-independent and may run
concurrently; "push before pull" is just a sensible default (local changes durable
and visible first). A change another device commits _between_ the list pull and
your push is a TOCTOU window that degrades to the same accepted LWW overwrite until
conditional writes close it.

> **Step 2's pending-op test is re-taken at APPLY time, in step 4's own
> transaction — never trusted as a snapshot.** A cycle is many round trips long,
> and _this_ device keeps writing through it: the extension's active-tab
> extraction writes `extractions/{id}.enc` while the very save that triggered it
> is still syncing, and a user keeps typing. Such a write is **absent from step
> 2's snapshot**, so both of step 4's writes used to run straight over it —
> `applyDeletes` matched a brand-new create against the "local only, not queued"
> row below and deleted it, and a download landed the server copy on top of a
> local edit. Both leave the **pending op behind**, and that is what makes the
> delete case unrecoverable rather than merely lossy: the op is now unpushable
> **forever** (no bytes to upload → every commit answers `no_object` → by design
> the path requeues), so the queue sticks at a non-zero pending count that no
> sync can drain and the entity is gone — typically an extraction, so a link
> silently stuck without its title/image. The download case is quieter and just
> as wrong: the surviving op then uploads the _server's_ bytes back, laundering
> the lost edit into a legitimate-looking commit.
>
> So `applyDeletes` and the pulled-record put (`putPulled`) both re-read the
> queue **inside their own write transaction**. IndexedDB serializes the
> overlapping `rw` transactions, so a concurrent local write either commits first
> (its op is visible → the path is spared) or after (its put re-creates the
> record) — both orders end with the local write intact. (That argument takes the
> op to stay queued until this cycle is over, which holds because this cycle is
> the one drain running — in another tab too, by the cycle lock; see _two tabs,
> one queue_.) The re-read is per
> record for downloads, since each arrives after its own GET; batching them would
> hold a chunk's decrypted blobs in memory and cost the resume-where-interrupted
> property. As a backstop for a queue **already** wedged, a pending `put` whose
> local record is gone is dropped from the queue instead of retried — a write
> stores the record and enqueues its op in ONE transaction, so an op without
> bytes is never a write that hasn't landed yet.
>
> **Dropping that op unwedges the queue but, alone, leaves the entity locally
> ABSENT** — so the heal has a second half. Step 2 had already reserved the path
> for the push (local-wins keeps every pending path out of the download set),
> which kept the server's copy out of a push that then never happened. So after
> the drop, the cycle **re-adds whatever its window shows for that path** to the
> download set: the pulled `put` op in an incremental cycle, the listed file in a
> fallback. A pulled `delete` is honoured (nothing is resurrected), and a path
> with no op in the window stays absent until a fallback re-lists it — the op
> that wrote it is behind the cursor, and inventing a download for a path the
> server may no longer have would be worse.
>
> **The same rule governs step 3's CLEAR: a drain removes the ops it pushed, not
> the paths it pushed.** The queue is one row per (account, path), so a re-edit
> before the drain collapses onto the same row — which means a drain that deletes
> by path deletes whatever is there when its commit returns, including an edit
> made _during_ the push, whose bytes never went up. That one is the quietest
> failure in the whole engine: the local store keeps the change, the queue keeps
> nothing, and there is no error, no pending count, and no retry to notice — the
> edit simply never syncs. So each queue row carries a **`writeId`** minted per
> enqueue, and the clear is a **compare-and-delete** on it (`clearDrainedOps`).
> `baseUpdatedAt` can't serve: a mid-cycle re-edit reads the same base, because
> the commit's restamp hasn't landed yet. **Settings is where this surfaces
> first** — `settings/general.enc` is the one path every client rewrites in place,
> and a theme picker fires a write + a sync kick per click, so click N+1 lands
> inside click N's push window. Entity namespaces mint a fresh path per record
> and collide far more rarely, which is exactly why the bug read as
> "settings don't sync" rather than as a general one.
>
> **And it governs what step 3 UPLOADS: a drain sends the write its op stands
> for, not whatever is at the path by then.** An op carries no bytes; the record
> is read when its own upload starts, round trips after the queue was. So that
> read is paired with the queue row's `writeId`, in one transaction, and an op
> whose row has been replaced since is **superseded** — skipped, kept out of the
> commit, and left to the cycle that reads the newer op. What that closes, and
> what it costs, is under _who enforces ordering_.
>
> **Both engines carry all four guards**, and they land differently per platform.
> web-react re-reads the queue inside a Dexie multi-store transaction
> (`applyDeletes` / `putPulled`); expo-react composes the read into the write's own
> synchronous sqlite transaction (`item-store`'s `putItemsUnqueued` /
> `deleteItemsUnqueued` over `pending-store`'s `queuedPathsTx`), and clears with a
> `(username, path, write_id) IN (VALUES …)` predicate evaluated inside the DELETE
> — so it needs no read-then-filter step at all. It is one DELETE per batch of
> ops, not one per op, because a statement per op cost ~0.6 s of JS thread per
> 1,000-path commit together with the restamp beside it
> ([data-lifecycle.md](./data-lifecycle.md), _readings — expo_). The upload-side
> pairing is one read transaction over `items` and `pendingOps` on web, and
> `item-store`'s `getItemForOp` over `pending-store`'s `queuedWriteIdTx` on expo.
> expo's `write_id` is `NOT NULL` where web's is a
> plain required field: neither store validates, so in both cases it is the type
> system that has to stop a future writer enqueueing an untagged row.
>
> Regression coverage for all of the above:
> `packages/web-react/src/sync/engine.spec.ts`.

### the cursor is a claim

A cursor is only worth what it promises: _this client has applied every op at or
below this point_. Everything a keyset pull does afterwards takes that on trust —
it asks for what is ABOVE the cursor and never looks below it again. So the rule
for writing one is narrow, and both engines hold every write of it to it:

- an **incremental cycle** advances the cursor to the last op it **listed**, and
  no further;
- a **listing-built flow** — the first sync, the fallback — ends on the **op
  log's newest stamp, read before the listing**, with an empty path.

Never on a stamp the client merely holds. There were two of those, and each put
another client's op below the cursor, silently and for good.

**Its own commits.** A cycle used to end on the newer of what it had listed and
what it had just committed, "so the next cycle doesn't re-fetch them":

1. Client A lists the op log; its last page ends at `w`.
2. Client B — another device, or the browser extension beside the web app —
   commits an op X. The commit clamp stamps it above everything in the log, so
   `x > w`.
3. A commits its push. The clamp stamps that above everything too, X included:
   `a > x`.
4. A advanced its cursor to `a`.
5. A's next pull is the keyset `(updated_at, path) > (a, …)`. X is below it and
   is never returned. The cursor is inside the log's range, so nothing routed A
   to a fallback either.

A lacked whatever X was — a link saved on the phone that never appeared, an edit
that never landed, a delete that never applied (and a link A still shows is a
link A can edit, which re-creates it everywhere). The cycle completed and the
queue drained, so the indicator read idle. The window ran from A's last
`ops/list` page to its last commit: a sign, an upload and a commit for one edit,
the **whole push** for an import — and a `429` on `files/sign` or `ops/commit`,
which share a ten-calls-per-ten-seconds limit per ACCOUNT across all its devices
and tabs, parked the cycle inside that window for the length of its
`Retry-After`.

It was not a corner. Reproduced on the local stack with two browser profiles of
one account (2026-10-06). With A's commit held for one round trip while B saved
a link, A never received it: three syncs and a reload later, queue empty, cursor
in range. And with **nothing held** — both profiles simply saving links at the
same time, one every 1.5 s and the other every 4 s — A ended up missing 3 of B's
8 links and B 6 of A's 20 at 100 ms of added latency per request, 4 of 8 with no
added latency, and 2 of 12 at a slower pace that tripped no rate limit.

**The newest stamp of a listing.** The first sync and the fallback used to end on
the newest `(updatedAt, path)` among the files they had listed, and the fallback
folded its own commits in as well. But the listing is paged and is **not a
snapshot**: an object another client writes into a key range the listing has
already passed is absent from it. If anything listed afterwards carries a newer
stamp, the cursor lands past an op the client was never shown. A device signing
in while another was saving came up short by exactly those links. Measured the
same day, with the page size cut to four so that a forty-link library paged the
way a large one does: 3 of 12, 2 of 11 and 3 of 10 links saved during the
listing never arrived — each time precisely the ones that were not in the
listing and were stamped at or below its newest.

**Why the log's newest stamp can be claimed, where a listing's cannot.** Three
things that already hold:

- every op at or below it was committed before it was read, and a commit is
  R2-first, log-last (_source of truth_) — so a listing that starts afterwards
  reflects it: the object is there, or a later state of that path is;
- the commit clamp stamps every later op **strictly** above it (_the three
  flows_) — so the next incremental pull lists it, whatever R2 time it carries;
- R2 lists consistently after a write.

Nothing in that compares R2's clock with the log's, which the old reconstruction
had to. The fallback already has the value in hand — its routing peek is
answered before `listAllFiles` starts — and the first sync makes the same read
for itself (`logWatermark`, in both engines).

**The claim covers what the listing does not show.** "Everything at or below the
watermark is in the listing" has two halves: the ops that put a path, and the
ops that deleted one. A flow that ends on the watermark has to honour both. The
fallback always has — it downloads what is new or newer and drops what is
local-only and unqueued. The first sync honoured only the first, on the
assumption that a first sync starts from an empty store, and it does not always.
A pull that dies partway — a dropped connection, a closed tab, the app killed —
leaves what it had stored and the flag unset, and the next load runs the pull
again, minutes or days later. A link deleted on another device in between is in
the store and not in the retry's listing, and its delete op was committed before
the retry read the watermark: at or below the cursor the retry ends on, where no
later pull returns it. Nothing ever removed it. The link stayed on that one
device, and a link a device still shows is a link it can edit — which puts it
back everywhere.

That hole is older than the watermark. A cursor taken from the listing's newest
stamp sat past the delete as soon as anything had been saved after it, which
over days is always. The watermark only made it unconditional, bar a delete that
is the very newest op in the log and comes back as a tie. So `runInitialSync`
applies the fallback's local-only row after its downloads (`localOnlyPaths`, then
`applyDeletes`) in both engines. `applyDeletes` re-reads the queue as it always
does, because "in the store and not in the listing" also describes a link this
device saved and has not pushed — the browser extension can save one before its
first sync has finished — and that one is kept.

**What it costs.**

- _The echo._ A cycle's own commits are no longer behind its cursor, so the next
  cycle lists them back. That is one op row each and no transfer: the commit
  restamped each record to the very stamp its op carries, so `storeDownloads`'
  staleness skip passes over it, and an echoed delete finds no record. On web the
  skip settles `files/` paths off the `updatedAt` index's key cursor first —
  a content record's `data` IS the cached blob, and comparing stamps must not
  read megabytes to learn that nothing changed; expo keeps content on disk and
  needs no such step. (The path was always live: a cycle that failed after its
  push left its commits un-folded. It is just the ordinary one now.)
- _Ties at the watermark._ `(newestUpdatedAt, '')` has no path half, because the
  wire carries no path with the bounds. The pull after a listing therefore
  re-lists the ops stamped at exactly that millisecond; replaying them is
  idempotent and the same skip absorbs it.
- _An empty log has no watermark._ A brand-new account, or one wiped under a
  returning client, reads as `(0, '')`. That claims nothing and routes the next
  cycle to the fallback again; once the log has its first commit, ONE more
  fallback reads a real watermark and the account settles into incremental
  pulls. For a new account that is one extra `files/list` of a near-empty
  namespace, on its second push. A cursor that never left `(0, '')` would
  re-list the whole library on every cycle instead, which is what the spec pins
  against.

**What it does not change.** An `object-without-op` is still invisible to
incremental pull and healed only by a fallback (_source of truth_). And the
conflict policy is untouched: this is about a client READING every op, not about
which of two writes to one file wins.

Coverage: `packages/web-react/src/sync/engine.spec.ts`, _the cursor claims only
what a cycle read_ — against a server model that keeps the keyset, the clamp and
a non-snapshot listing, because a stub that answers every pull alike cannot show
an op being skipped; it carries the first sync's retry too, with the control that
a link saved here and not yet pushed survives it. The drift guards are in
`packages/expo-react/src/sync/engine.spec.ts` (there the retry's leftover is a
`files/` row, since dropping one is a row and a file on disk); the strict clamp
in `apps/bracemark-api/src/do/user-data.spec.ts`; and `SYNC-CURSOR-001` /
`SYNC-LISTING-001` / `SYNC-RETRY-001` on the real stack ([e2e.md](./e2e.md),
_cross-client sync_).

### fallback full sync (download-authoritative)

When routing lands on fallback (`since` older than `oldestUpdatedAt`, or ahead of
`newestUpdatedAt`), the op log can't reconstruct what changed, so the client
reconciles directly against R2. The fallback endpoint lists paths with their
`updatedAt` — which is **R2's own `LastModified`** (the timestamp R2 stamps on
every PUT, and the same value the client stores locally on each sync) — **one R2
page per call**:

```
GET /v1/files/list?limit=1000
→ {
    files: [ { path: "links/l_abc.enc", updatedAt: 1744538400000 }, ... ],
    nextPageToken: "…" | null,   // R2's opaque list cursor; null when complete
  }
```

The whole namespace can be thousands of objects, and each R2 `list()` is one
subrequest capped at 1000 keys, so the listing is paged: the client passes
`nextPageToken` back as `pageToken` and **loops until it comes back null**.
`pageToken` is **opaque** — it's R2's own list cursor relayed straight through, not
a path or a keyset on `(updatedAt, path)` like `ops/list` (that endpoint queries
the DO's SQLite, where we own the ordering; this one rides R2's native cursor over
a listing we don't control — R2 lists in key order, not time order). Two
consequences: the client **can't stop early** (R2 lists in key order, not time
order, so every page has to be read), and the listing is **not a snapshot**
(pages span concurrent writes, and an object written into a key range already
passed is simply absent). That is safe for what gets DOWNLOADED — fallback is
download-authoritative and `updatedAt`-compared — and whatever changed
mid-listing is caught on the next sync **only because the cursor the fallback
ends on predates the listing**. A cursor taken from the listing's own stamps sits
past what it missed (_the cursor is a claim_).

Using R2's own clock — not a separately-minted timestamp — is what lets fallback
recover a _commit-died edit_ (`object-without-op`, case B): the new bytes carry a
fresh `LastModified` in R2 even though no op was ever recorded, so the comparison
below still sees the server copy as newer and re-downloads it.

The fallback is **download-authoritative**: the server list is treated as truth
for every path **without** a pending local op, so a server-side deletion is never
resurrected and a stale leftover is dropped. A path **with** a pending op is a
genuine unsynced local intent, and it resolves exactly as the incremental cycle
resolves it — **local-wins** — so a fallback (an infra event: log wiped,
compacted, reset) never silently flips a conflict to server-wins, clobbers a
queued edit, or resurrects a bookmark whose delete is still queued:

| local vs. server                                     | action                                            |
| ---------------------------------------------------- | ------------------------------------------------- |
| on server, no pending op, newer `updatedAt` (or new) | **download**                                      |
| pending op for the path (`put` or `delete`)          | **push** — local-wins, same policy as incremental |
| pending `delete`, object already gone server-side    | **push anyway** — idempotent; see below           |
| local only, **not** in pending-ops queue             | **delete locally** — it was deleted server-side   |
| on server, no pending op, equal `updatedAt`          | skip                                              |

The local-only row is what kills the deleted-bookmark-resurrection bug, and it
needs no user prompt. The comparison uses the **stored server `updatedAt`**,
never Dexie's local write time. It is also the row most exposed to a write that
lands mid-cycle (an unpushed create is local-only by definition), so its
pending-op test is re-taken at apply time — see the note under _a sync cycle_.

The already-gone `delete` is still pushed because the absence is ambiguous:
usually another device committed the delete (so the re-commit costs one
redundant op row), but it can also be **this device's own commit that crashed**
between the R2 object delete and the DO write — and then the retried commit is
the only thing that ever logs the op (so incremental pullers learn of the
deletion) and frees the path's recorded size from the quota map. Commit is
idempotent on both stores (deleting an absent key is a no-op; freeing an
unrecorded path frees 0), so pushing unconditionally is always safe — dropping
the op instead would leak the `file_sizes` entry forever (paths are never
reused, so no later commit would ever touch it).

After reconciling, set the cursor to the **op log's newest stamp as the routing
peek saw it** — read before the listing started — with an empty path (_the cursor
is a claim_). Not to the newest `(updatedAt, path)` among the listed files, and
not to this cycle's own commits: the listing is not a snapshot, and a commit is
stamped past whatever another client committed while this one pushed, so neither
says what was missed. Everything at or below the peeked stamp is in the listing
just reconciled; everything committed since — by another client mid-listing, or
by this cycle's own push — is above it and comes back on the next pull. In the
`since > newestUpdatedAt` case this lowers the cursor _below_ the stale value it
had: the old cursor pointed past the log, so it is reset down to it. An
**empty** log has no stamp to end on and leaves `(0, '')`, which routes the next
cycle here again until the log has a commit to stand on.

### multi-file consistency & orphans

A bookmark spans 2–3 files (metadata + content + page copy). Consistency comes from
two cheap rules, not transactions:

- **upload metadata LAST, delete metadata FIRST.** The metadata file is what
  makes a bookmark "exist," so a half-finished create leaves only orphaned
  content (harmless) and a half-finished delete leaves only orphaned content
  (harmless) — never metadata pointing at a missing file in a way the UI can't
  absorb (and it absorbs dangling ids anyway).
- **R2 object PUTs are atomic**, so even an in-place content _update_ never
  yields a torn read: a reader gets the whole old object or the whole new one.
  This is why immutable/versioned content files are **not** needed — meta-last /
  meta-first plus atomic PUT fully cover multi-file consistency.

**Orphans can't be garbage-collected server-side** — the server can't read the
ciphertext to know what's referenced. The only place GC is possible is the
**client**, which holds the key, can decrypt all metadata to compute the
referenced set, and delete the rest. We don't do this yet; the per-user quota
bounds the growth, and orphans are produced only by rare mid-flight failures.

### who enforces ordering: server per-commit, client cross-commit

Two **independent** ordering constraints keep the system consistent, and they
live in two different places **because of what each side can observe and
control** — the split is forced, not stylistic.

- **A — R2 ↔ op-log, _within_ one commit.** The R2 mutation must land before the
  DO log write: a `put` is verified to exist (listed or `HEAD`ed) before its op is logged, a
  `delete` removes the R2 object before logging the delete. This is the
  `op-without-object` invariant (see _source of truth_), and **only the server
  can own it** — the client can't write the op-log at all, and can't DELETE R2
  directly (`files/sign` mints only PUT/GET). Both halves happen inside
  `commitOps` (`services/sync.ts`): `deleteMany` R2 → check puts → one DO
  `commitOps` last. The DO write is the atomic point, so a puller sees an op only
  once its object is real.

- **B — metadata ↔ content, _across_ commits.** The global phase order
  `[delete-metadata, delete-content, put-content, put-metadata]` (the meta-last /
  meta-first rules above, generalized across chunk and commit boundaries), so a
  metadata object never references a missing content object across any crash
  boundary. This is a property of the **sequence** of commits, and **only the
  client can own it**, for three reasons the server can't get around:
  1. **No referential knowledge.** Content is opaque (E2E). The server sees
     `links/{id}` and `files/{id}` as unrelated paths; it can confirm _an object_
     exists (that's A), never that _the content this metadata points at_ exists —
     it can't read the reference graph, and a note may reference zero or many
     content files.
  2. **It sees one batch, not the order.** Each commit is handled in isolation
     with no memory of phase; the phase order lives in the client's pending queue.
  3. **It doesn't read the upload path.** Content is PUT over a signed URL out of
     band — past the server entirely when presigned, through a route that streams
     opaque bytes and records nothing when not (_the blob route_); either way the
     server only learns of it at the commit's existence check.

A is the **primitive B is built on**: because every commit is R2-first/log-last
and the DO write is atomic, each phase is durable as a unit before the next
begins. That durability is exactly what lets the engine sequence the four phases
and trust each is real before opening the next. The engine realizes B in
`pushPending` (`packages/web-react/src/sync/engine.ts`), and two things there are
**load-bearing for correctness**, not just tidiness:

- **sequential `await` between phases** — the durability-before-next-phase
  guarantee _is_ this ordering; and
- **one cycle at a time per account, on the whole device** — two concurrent
  drains would interleave phases and break the global order. Inside one JS
  context that is single-flight (`inflightSyncs`): module state, so it serializes
  the cycles of one tab and no more. Two tabs of the web app are two contexts
  sharing one queue, so on web each cycle also runs under a **cycle lock** that
  spans the origin — see _two tabs, one queue_.

**Single-flight makes a cycle that never settles an outage, not a slow sync.** The
slot is freed only in the cycle's `finally`, and every later caller — background
sync, a refresh, export's and import's pre-sync refresh, delete-all's wait — joins
the cycle in flight. `fetch` has no deadline of its own, so a server that accepts
the connection and never answers would hold the slot for the life of the page (web)
or the process (expo): export stuck on its sync step, and every later cycle joining
the dead one. What prevents it is the contract client's **default call deadline**
([api-contracts.md](./api-contracts.md), _deadlines_). Every bracemark-api call the
engine makes is bounded, a timeout fails the call unretried, and that fails the
cycle and frees the slot. Export and import then fall back to the local copy, as
they do for any failed refresh. The engine does no wiring of its own, so a stub
api (the rest of `engine.spec.ts`) cannot see a regression. What guards it is one
case that drives a cycle through the real client (_a server that accepts the
connection and never answers_). The R2 transfers inside a cycle are bounded the
same way (`sync/r2.ts`): a web download by an idle deadline that only a stalled
body trips, the rest by a deadline sized to the blob (`blobTransferTimeoutMs`),
and expo's native file transfers by their own idle timeouts. See
[api-contracts.md](./api-contracts.md), _deadlines_, the paragraph _outside this
client_. On web the cycle lock carries the same exposure across tabs — a second
tab's cycle waits for the first's — so those deadlines are what bound it there
too.

**The same outage has a second road: a slot that is filled after it was freed.**
`runIncrementalSync` creates the cycle's promise and THEN stores it, and the
`finally` that frees the slot belongs to that promise. Anything that throws
before the cycle's first `await` runs the `finally` first and the store second,
which leaves a rejected promise in the slot for good — every later sync joins it
and fails with an error from long ago. On web, taking the cycle lock is the
first thing a cycle does, and that put a throw within reach of the window: a
`navigator.locks.request` that throws rather than rejects (a shim, a locked-down
webview) would have ended sync until a reload. `incrementalSyncOnce` is an
`async` function for that reason alone, though nothing in it awaits; an `async`
function cannot throw synchronously. Coverage: _frees the slot when the lock
itself cannot be taken_, with _still syncs where Web Locks are missing_ beside
it (`engine.spec.ts`, _two tabs, one queue_).

> **B holds over the bytes, not only over the ops.** A cycle reads the pending
> queue once, at the top, and orders the ops it read. But an op carries no bytes:
> each `put` reads its record from the store when its own upload starts
> (`uploadBlobs`), which can be many round trips later. So the phase order used
> to hold over the ops and break over what was actually uploaded. A metadata op
> that was already queued uploaded whatever its record held THEN. A content file
> and the reference to it are two local writes, content first — `writeFile`, then
> `writeExtraction` or the link edit — and if both landed after the queue was
> read and before the metadata phase reached that path, the cycle committed
> metadata naming a `files/` blob it held no op for and had not sent.
>
> Two writers do this to a path that is usually already queued: **server
> extraction** (`lib/server-extraction.ts`), which writes the title into
> `extractions/{id}.enc` in its first pass and in its second writes the image to
> a fresh `files/{id}.enc` and patches `imageId` into the same extraction — so
> any cycle that starts between the passes holds the extraction's op and not the
> image's; and **a custom image on a link that already has an edit queued**
> (`saveCustomImage`, then `update({ customImageId })`). Nothing was lost — the
> newer `writeId` kept the metadata op queued, and the rerun pushed content and
> then metadata — but in between, the server held a reference to an object that
> was not there, and another device pulling inside that window remembered the
> miss for the rest of its session (its file-content provider does not ask
> again). The content-failure hold above did not cover it: a content op the
> cycle never read cannot fail in it.
>
> **So an upload sends the write its op stands for, or nothing.** `uploadBlobs`
> reads the record TOGETHER WITH the queue row at its path, in one transaction,
> and uploads only if that row still carries the `writeId` the cycle read. A
> write replaces the `writeId` in the same transaction that stores its bytes, so
> a match means these are exactly the bytes the op was queued for; anything else
> is a later write, and the op is **superseded** — skipped, kept out of the
> commit, and not an error. The later write is queued under its own id and has
> asked for the cycle that will carry it, with its content, in phase order.
> Four things follow:
>
> - A superseded op is told apart from an **orphan** before the orphan test. A
>   path deleted since the queue was read has no record either, and it is a newer
>   intent, not a wedged op to heal — the heal would go and fetch the server's
>   copy of something this device had just deleted.
> - A path rewritten faster than a cycle reaches it is not uploaded until the
>   rewriting pauses — a theme picker clicked through, one facet completing after
>   another. Each write still asks for a cycle, so the last one is pushed; what
>   is given up is the redundant uploads of the ones in between.
> - On expo the pairing pins the ROW and, for a `files/` path, its claim on the
>   plaintext; the file itself is read off disk by the native encrypt afterwards,
>   as it always was. Every capture mints a fresh `files/` id, so in ordinary use
>   a content path is written once; a backup restore is the one writer that can
>   land on a content path that already exists.
> - The test is per op, and a superseded CONTENT op holds nothing back — unlike
>   a failed one, which holds the whole metadata phase. Metadata the cycle still
>   holds unchanged goes up in the same cycle. So the window is not shut for a
>   `files/` path rewritten or deleted while its op is in a cycle's hands and
>   its metadata's is not. One writer does that in ordinary use: destroying a
>   link deletes its `files/` a transaction ahead of its extraction (`destroy`,
>   `hooks/use-link-mutations.ts`), and a cycle whose metadata phase reads the
>   extraction in between uploads it naming an image whose put it has just
>   skipped — until the next cycle, which deletes it. Left as it is: the
>   extraction belongs to a link on its way out, and a wholesale hold would make
>   every unrelated edit in the cycle wait for it.
>
> Coverage: `packages/web-react/src/sync/engine.spec.ts` (_an op whose path was
> rewritten after the queue was read_); on expo, one drift guard in its
> `engine.spec.ts` and the `getItemForOp` cases in `data/item-store.spec.ts`.

Neither constraint can be moved to the other side. Pushing B server-side would
require exposing the reference graph to the server (weakening E2E opacity) and
**still** wouldn't buy atomicity — R2 has no multi-object transaction and the
uploads are out of band — so the crash windows would remain. The current
placement (A = server/per-commit, B = client/cross-commit) is the minimal correct
arrangement.

### two tabs, one queue

Single-flight serializes the cycles of one JS context, and for every client but
one that is the whole account on that device. The browser extension runs the
engine only in its background worker. bracemark-expo has one runtime per store:
the Android share activity lives in the app's process, and the iOS share
extension writes an outbox file and never opens the store
([share-sheet.md](./share-sheet.md)). **bracemark-web is the exception.** Every
tab on the origin opens the same Dexie database and loads its own copy of the
engine, with its own `inflightSyncs`, and every tab that reaches `ready` kicks a
cycle. A second tab opened while the first was pushing was a second drain of the
same pending queue.

**So a cycle runs under a lock the whole origin shares.** `withCycleLock`
(`packages/web-react/src/sync/engine.ts`) takes a Web Lock named for the account
around each cycle — from its read of the queue and the cursor to its last
write — and around the first sync. A second tab's cycle waits, and then reads
the queue the first one left. Nothing else in the engine changed, and nothing
had to: every argument in this document that begins "a cycle is the only drain"
is now true of the device rather than of the tab.

A second tab's FIRST sync waits the same way, and then does nothing. Two tabs
open on the sign-in page both adopt the one sign-in, and each provider starts a
pull; unlocked, they listed and downloaded the whole library side by side. The
flag is re-read inside the lock, and the pull the first tab just finished was
the device's: the store is complete up to its cursor, and listing the namespace
again would only hold the lock against the cycle that comes next.

**bracemark-expo's first sync takes no lock, and needed the same separation
anyway** — its engine's cycle lock is runtime-local and exists only for
`holdSyncCycles` (see [data-lifecycle.md](./data-lifecycle.md), _delete all
data_), and a cycle
and the first sync must not overlap, in one runtime as much as in two tabs. A
write can land before the first sync is done there, where on web the gate keeps
every editor out: a share, saved by the Android activity or drained from the iOS
outbox ([share-sheet.md](./share-sheet.md)). The write is safe — it is queued,
and the pull spares a queued path in both directions. The cycle its own kick
started was not. `runInitialSync` is outside the single-flight, so that cycle ran
beside the pull: it pushed the link and cleared its op, and the pull, still
reconciling against a listing taken before the push, then met a path that was
local-only and unqueued and dropped it (_the three flows_, the first sync's
second paragraph — the rule was right, and the queue test it rests on had just
been emptied by a cycle that should not have been running). The server kept the
link and a later cycle listed it back, so nothing was lost for good; the device
simply did not have what its user had just saved, for as long as that took.
The same cycle had no cursor, so it routed to the fallback and downloaded
everything the pull had not stored yet a second time. So expo's
`incrementalSyncOnce` **returns without doing anything while the first-sync flag
is unset**: a pull only runs with the flag unset and no cycle starts until it
is set, which is the whole of what the lock gives web here. What is queued waits
for the cycle the provider kicks on reaching `ready`.

That argument needs two things to be true of **every** pull — it began with the
flag unset, and it is the only one running — and both were the provider's doing
rather than the engine's. The provider reads the flag, waits on the lifecycle
lock for its claim, and only then calls `runInitialSync`; nothing stopped an
effect that re-ran over a pull still in flight from starting a second beside it.
Whichever finished first set the flag with the other still reconciling against
its own older listing, and a cycle was then free to run beside that one — the
same overlap, by another door. So expo's `runInitialSync` holds **a slot per
account**: a second caller joins the pull in flight (its `onProgress` is fed from
where it joined, since it is usually the only gate still on screen), and the
pull **re-reads the flag inside the slot** and does nothing once it is set.
Those are the two things web's pull gets from the cycle lock, above; with one
runtime per store the slot is the whole lock. This half is read from source, not
reproduced — the triggers found were the same account signed out and back in
mid-pull, and a session that paused and resumed. Coverage: expo's
`engine.spec.ts`, the first-sync cases under _the cycle, against this copy of
it_.

**What two drains did**, kept here as the reason the lock exists. Four things
are each sound while only one cycle can run, and together were not:

1. **The PUT is unconditional.** Whichever of two uploads to a path reaches R2
   last is the object, whatever order the edits were made in.
2. **A commit names a path, not a write** (`{ op, path }`). It is accepted if the
   object exists; it cannot say _which_ bytes it is acknowledging.
3. **The restamp is by path and unconditional** (`commitBatched`). It gives the
   local record the committed stamp whatever bytes that record now holds. With a
   newer op still queued that is harmless; with none it is a claim that the
   record matches the object.
4. **The pulled writes test only whether an op is queued** (`putPulled`,
   `applyDeletes`, and the orphan heal through them). "No op" is read as "no
   local write since this cycle decided" — true when this cycle is the only thing
   that clears ops, false once another tab has pushed the write and cleared it.

With tab A holding the earlier read of the queue and tab B the later, that gave:

- **A stale upload over a newer one.** A has read a path's bytes and its PUT is
  still out. The path is edited; B's cycle starts after the edit, uploads the new
  bytes, commits and clears. A's PUT then lands and replaces the object, its
  commit is accepted (2), and its restamp stamps the record that holds the _new_
  bytes (3). The server has the old bytes, the local store the new, and nothing
  is queued: the EARLIER of two edits made on one device is the one every other
  device gets. A fallback compares stamps, not bytes, so it could not put this
  right afterwards — it had to be prevented.
- **A stale upload after a delete.** Same shape, with the edit replaced by a
  delete that B commits first: A's PUT re-creates the object. A destroyed link
  comes back on the other devices without its extraction, pin or files.
- **A stale delete after a re-put**, on the two namespaces that reuse a path
  (`pins/`, `extractions/`): A's delete commit arrives after B has pushed the
  re-put, and removes it. The local store has the record, the server does not.
- **A pulled put over an edit.** A is mid-GET for a server copy newer than its
  local stamp. The path is edited, and B pushes the edit and clears the op. A's
  `putPulled` finds no op (4) and stores the older copy over the edit.
- **A pulled delete over an edit.** A holds another device's delete for a link
  that is then edited here; B pushes the edit, which re-creates the object, and
  clears the op. A's `applyDeletes` finds no op and removes the record on the one
  device that made the edit.
- **The orphan heal bringing back a delete.** A holds a `put` for a path that is
  deleted locally before A reads its bytes, drops the op and re-adds the server's
  copy to its downloads, guarded only by the queued delete. B commits that delete
  and clears it; A's write then finds no op and stores the old copy. (The upload
  now treats that op as superseded, not orphaned, so this one is closed twice —
  _who enforces ordering_.)

Every one ended with an empty queue and a cycle that completed, so the indicator
read idle: no error, no pending count, no retry.

**Reproduced, and how rare it was.** On the local stack, two tabs of one profile
(2026-10-06). With one of tab A's transfers held for the length of tab B's
cycle, three of those orders were produced end to end: the server kept the
earlier of two edits while the device showed the later, with the R2 stamp equal
to the local one, so a fallback would have skipped it; a link deleted for good
came back on the server and on a freshly signed-in profile; and a link edited
here vanished from this device while the server kept it. Without a held transfer
it did not happen — three runs of twenty-four alternating edits from two tabs
converged every time — because the push-side orders need ONE transfer to outlast
the other tab's whole cycle: a stalled connection, a retry backoff, a large
`files/` body. Rare, then. But silent, and in the first case unrepairable, which
is why it is closed rather than written down as accepted.

**Why a lock, and why this one.**

- It removes the cause. Every order above needs two cycles to overlap, and once
  they cannot, none of the four mechanisms needs rewriting.
- The other tool this document names for a stale write, the conditional PUT
  (_conflict policy_), is the right one for two DEVICES and the wrong one here.
  Between two tabs a refused write is not a conflict with another device: the
  tab holding this device's newest bytes may be the one refused, so "re-pull,
  then retry" is the wrong answer for it, and it is the queue row, not the
  server, that knows which write is newer. A stale **delete** has no PUT to
  carry a condition at all.
- **Per account**, because that is what the queue and the cursor are scoped to.
  A cycle for an account that has since signed out is fenced in the database
  ([sessions.md](./sessions.md)), and the next account's first sync must not sit
  behind its network calls timing out.
- **Not the session lifecycle lock**, which hydration takes on every startup
  ([sessions.md](./sessions.md)): held across a cycle's round trips it would hold
  the app blank behind another tab's sync.
- A Web Lock is released by the browser when its holder goes away, so a closed
  or crashed tab cannot strand it.

**What it costs, and what it leaves.**

- A second tab's cycle waits for the first's. That is the wait an edit made
  mid-cycle already has inside one tab, under the same bound: every call a cycle
  makes has a deadline (_who enforces ordering_). A cycle that never settled
  would now hold every tab's sync rather than one's, so those deadlines carry
  that much more.
- Each run takes the lock for itself, so a tab running reruns back to back still
  lets another tab's cycle in between them.
- **A holder that is suspended rather than gone** keeps the lock, and a visible
  tab's cycle waits for it. Chrome's background freezing exempts a page that
  holds a Web Lock; a mobile browser suspending a background tab mid-cycle is the
  case that has not been tested. Edits made meanwhile queue as they always do,
  and push when the lock comes free.
- **Where Web Locks are missing** the lock is skipped and the in-context
  single-flight is all there is, as before.
- **A tab running a build from before the lock** takes none. No released build
  lacks it: the lock went in before the first release.
- **Delete-all still quiesces one tab, not the device.** `deleteAllData` waits
  out THIS context's in-flight cycle before it clears the queue and wipes the
  server ([data-lifecycle.md](./data-lifecycle.md), _delete all data_); a
  cycle in another tab that had already read the queue is not waited for. The
  upload-time `writeId` test narrows what that cycle can still do: an op whose
  queue row the wipe cleared is superseded and sends nothing. What is left is
  the transfers already in flight when the queue was cleared, which had passed
  that test: at most one fan-out of them, `INDEX_CONCURRENCY` (96) blobs, of
  which at most `FILE_CONCURRENCY` (8) are large content. Such a transfer can end
  two ways. If it lands after the wipe's last R2 listing, the object survives and
  its commit logs it — a link back on a wiped account, up to that fan-out of
  them. If it lands sooner and its commit falls between the log wipe and the
  delete of its object, the commit's `HEAD` finds the object, the op goes into
  the emptied log, and the paging then removes the object: `op-without-object`
  (_source of truth_), with the path's size left in the quota map until that
  path is next committed or the account is wiped again. A puller skips the 404,
  so nothing shows. A chunk's commit runs beside the next chunk's upload
  (_a push is chunked_), so the commit of a chunk already sent can be in flight
  too, and its objects meet the second way — up to a chunk of them. Both are read
  from source, not reproduced. Running the wipe
  under the cycle lock would close both for a second tab; that is a change to a
  destructive path with its own watchdog, and has not been made. The second is
  not a tab's alone — another device committing during the wipe meets the same
  window, and no lock on this origin reaches it.
- The browser extension beside the web app is NOT a second tab. It is another
  origin, with its own store, queue and cursor: another client of the account,
  under the two-device rules (_conflict policy_, _the cursor is a claim_).

Coverage: `packages/web-react/src/sync/engine.spec.ts`, _two tabs, one queue_ —
two copies of the engine module over one database, with the real lock between
them: the second tab's cycle waiting, its first sync waiting and then listing
nothing, and a control that another account's cycle is not held up — and
`SYNC-TABS-001`, which is two real tabs ([e2e.md](./e2e.md), _cross-client
sync_).

### conflict policy

File-level **last-writer-wins**, which is cheap because granularity is one entity
per file. Accepted tradeoff, written down so it isn't a surprise:

> Two devices editing the **same** file concurrently → the later PUT wins and the
> earlier edit is lost silently.

For a single-user, multi-device manager this is acceptable. The cheap future
upgrade is **R2 conditional writes** (`If-Match` on the etag, or `If-None-Match:
*` for create) baked into the presigned URL, so a stale write `412`s and the
client re-pulls before retrying. Deferred, not designed away.

That tradeoff is the **two-device** one, and it is the only loss accepted here.
Two tabs of the web app on one device are not two devices: their cycles are
serialized, so two edits made in sequence there are pushed in sequence — see
_two tabs, one queue_.

### crypto boundary & what the server still learns

Every blob is AES-256-GCM under the single data key derived from the account DEK
(see [account.md](./account.md)); `@stxapps/web-crypto`'s `encrypt` uses a
**fresh random 96-bit IV per call**, so one key for all files is safe. Door
changes / password changes re-wrap only the 32-byte DEK and **never re-encrypt
data**, so the sync layer is entirely oblivious to them.

**Blob wire format.** Every R2 object is the binary frame
`[version(1) || iv(12) || ciphertext+tag]` — packed/unpacked by `blob.ts` in the
crypto packages (`@stxapps/web-crypto` / `@stxapps/expo-crypto`, next to the
AES-256-GCM primitive it wraps; the sync engine is the caller), and for `files/`
content on expo by the native `BlobFrame` (Swift, Kotlin). The constants
(`BLOB_FORMAT_V1`, `AES_GCM_IV_BYTES`) live in `@stxapps/shared`
(`crypto/params.ts`) because they are a **cross-platform contract** like the
key-derivation parameters: a blob packed on web must unpack on the browser
extension and bracemark-expo, forever. Raw bytes, deliberately not a JSON
envelope — base64 would inflate every blob ~33% (worst on the heavy content
files that count against the quota), and any plaintext field beside the
ciphertext (a content type, say) would leak to the server. What a blob
_contains_ (text vs. image, page copy vs. thumbnail) is described **inside the
ciphertext** of the metadata that references it, never in the frame. The
version byte is format-change insurance: a future layout (new cipher, different
IV size, compression) mints a new version constant and a new decode branch, so
old blobs keep decoding side by side instead of forcing a download-and-re-encrypt
migration; readers reject an unknown version loudly. The IV is 12 bytes because
96 bits is the recommended GCM size (other lengths take a weaker GHASH path) —
it would only ever change as part of a new versioned format.

**A blob is bound to its path.** Every writer seals with AAD =
`blobAad(path)` — the version byte, then the UTF-8 of the sync path the blob is
PUT to (`crypto/blob-aad.ts`) — and every reader supplies the path it fetched
from, so a blob opens only where it was written. The key already proves a blob
is the account's; without the path, whoever answers a GET (the server, in this
threat model) could hand back another of the account's own blobs — one link's
record for another's, a list for a list — and the tag would pass. The engines
pass the path at every seal and open (`encryptEntity`/`decryptEntity`, and
`encryptFile`/`decryptFile` across the native bridge, which builds the same AAD
itself).

The binding is part of v1 itself, not a later version. It went in before the
first release, so no released account holds an unbound blob, and no reader has
an unbound branch a server could steer it to. Builds from before the binding
wrote the same version byte with no AAD, and their blobs fail the tag.

**A pulled blob that fails the tag is skipped, not a failed cycle.** Both
framers throw shared's `BlobUnreadableError` for it — tamper, a blob sealed for
another path, one from before the binding, or corruption — and the engines'
pull (`openPulled`, inside `storeDownloads`) treats it like a mid-pull 404:
nothing is stored, a local copy the path already had stays as it was, and the
cursor moves on. It used to propagate, and one such path then failed every
cycle for good: the pull rejected with the cursor where it was, met the same
blob on the next cycle, and no other path in the account synced again. Skipped,
the path is read again only when it is rewritten or a fallback lists it, which
is what the server could already achieve by withholding it (below). An
**unknown version** is deliberately not skipped: that is a newer client's
format, an update reads it, and skipping would move the cursor past it for
good. The batch content fetch (`loadEntityContents` — an export's file phase,
the content provider) skips it the same way and reports the path in
`missingPaths`, as it reports a 404: it used to reject, and one such file then
failed every export of the library and re-fetched the provider's whole batch on
every mount. Any other failure — offline, a server error, a deadline — still
rejects by default, because the content provider remembers `missingPaths` for
the session and retries only after a rejection. The export instead passes
`bestEffort`, which puts such a path in a separate `failedPaths` and goes on
(a failed sign call fails every path left). A `session_revoked` verdict still
rejects, since the export is about to write the library out
([data-lifecycle.md](./data-lifecycle.md), _export_). expo's `decryptFile` maps the native tag and truncation failures
onto `BlobUnreadableError` for this, by the codes expo-modules-core infers from
the native exception classes. A single lazy load (`loadEntityContent`) still
rejects. So a dev or staging account synced by a pre-binding build
syncs again, without its old records — recreating it, or resetting the local
api's state for the seeded dev accounts ([e2e.md](./e2e.md), _seeding a dev
account_), is still how to get them back.

The golden vector holds the four framers to one byte string — `blob` opened
under its path, refused under another, and resealed byte for byte
(`crypto/contract-vectors.ts`). The two JS framers run under jest, the Swift and
Kotlin ones on the host (`swift test`, the JVM), and the dev-only
`/contract-vectors` screen runs the JS framer on each device through
quick-crypto; the native file framer has no on-device vector run.
**What the binding does not cover is which version of each path is served, or
which paths are.** An older blob written to the same path still opens there, so
the server can roll a path back to an earlier state. It can also serve a deleted
path's last blob again, leave paths out of a listing, invent delete ops the
client applies locally, mix versions across paths (an old link record beside
its current extraction), or withhold updates. None of these passes one path's
content off as another's, which is the part the AAD closes.

Even with E2E, the server still learns the **number of files, each file's size,
its timestamps, and access patterns** (which blobs are fetched when). Through the
blob route the api Worker observes those itself, transfer by transfer — the
token names the path — where a presigned transfer showed them only to R2; it is
the same set of facts and the same ciphertext, seen by one more of our
components. Its invocation log records that a transfer happened — when, from
which IP — and not which object: the URL is the same for every one, and the
token rides in the masked `authorization` header (_the blob route_). A transfer
the `blob` rate limit refuses adds the account id, still not the object. It does
**not** learn titles, URLs, tag/list names, or the metadata→content reference
graph (all inside the ciphertext). Keeping metadata uniformly small (`< ~2 KB`)
blunts size correlation. Acceptable for a bookmark manager — named here so it's a
decision, not an accident.

### authorization & quota

Because the server can't inspect contents, it must enforce policy on the
**envelope**:

- the wire carries each path **relative to the user's root** (`links/{id}.enc`, …),
  never the `/users/{uid}/` prefix. On **every** `POST /v1/files/sign` (and every
  `ops/*` / `files/*` call) the Worker derives the `/users/{authedUid}/` prefix
  from the session and prepends it (`lib/r2-keys.ts`), so a path can only ever
  resolve under the **caller's** namespace — one user **cannot** name another's
  object. The contract (`syncPathSchema` in `@stxapps/shared`) additionally pins
  the shape to a known namespace, so there's no separator or traversal sequence to
  smuggle a key outside it;
- on `op: 'put'`, additionally enforce a **per-user file-count and byte quota** at
  issuance — the only place abuse can be bounded when content is opaque. `op: 'get'`
  needs no quota (reading your own data), so download URLs can be **minted in
  batch** for a fast first sync without per-blob round-trips.

The byte total backing that quota is **not** summed from the op log — the log is
compactable and disposable, so it would undercount. It comes from a separate,
durable **per-path size map** — the `file_sizes` table in the same per-user DO
(`do/repositories/file-sizes.ts`): `path → size`, set from the commit's existence
check on `put`, read-and-subtracted on `delete` (a delete has no object left to check, so
the size to free must already be recorded). That map, not the op log, is where size
is persisted; the op-log row is just `{ seq, op, path, updated_at }`. The limits
themselves live in `lib/quota.ts`, checked by `services/sync.ts` against the DO's
`usage()` before any `put` URL is minted.

**The gate is namespace-blind, and reads only CURRENT usage.** It compares
`fileCount` and `totalBytes` against the plan's ceilings and ignores what the
batch is about to add — the same conservatism the byte check always had, since a
new object's size is unknown until it's uploaded, so growth is charged on the next
batch. One DO RPC (`usage()`) and one D1 read, in parallel, per put batch.

Namespace-blind means `fileCount` counts **paths, not links** — one link is 2
objects (`links/` + `extractions/`) before its preview image makes 3 — so the
ceilings bite at a fraction of their face value in links. And **the plan they
come from is the account's high-water one**, not its current one: the D1 read
folds the purchase rows through `foldQuotaCeilings` (services/iap.ts), which
takes the best plan the account has ever held. A lapsed subscription therefore
never turns an already-uploaded library read-only — which matters here because
over the ceiling even a move-to-Trash is refused (it is a `links/` put), leaving
only irreversible delete. The reasoning is in docs/iap.md, _enforcement_.

That simplicity is recent and was bought by moving the free tier's **200-link cap
off the server**. While the gate counted `links/` it also
had to tell a **create** from an **in-place update** — an account at its cap must
still be able to retitle, retag and above all move a link to Trash
(`update({ listId: TRASH_ID })`, docs/editors.md), which is itself a `links/` put
and the first half of the only route back under the cap. That meant an
`existingPaths` lookup against the size map on every sign batch, subtracted before
the check. What remains needs none of it: a ceiling no legitimate account reaches
does not have to care whether a put is a create, whereas the link cap — a limit
every free account is _designed_ to sit at — always did. See docs/iap.md,
_enforcement_, for the full trade.

### where TanStack Query fits

The dividing line is **React-component calls vs. the background sync engine**,
not Hono-vs-R2.

**Use it for component-facing API endpoints.** Auth (username check, sign-in,
create-account, session), account settings, a sync-status read — these go through
TanStack Query (`useQuery`/`useMutation`) for uniform loading/error/retry/dedup
state and devtools. Those hooks live in `@stxapps/react` and call the injected
client via **`useApiClient().call(endpoint, …)`** (the contract client from the
provider — see _assembling the client_ in [api-contracts.md](./api-contracts.md)),
so the shared contract stays the single source of truth and the hooks stay
reusable on bracemark-extension and (future) bracemark-expo.

**Don't use it for the local-first data path.** The Dexie `liveQuery` store is
already the read cache for bookmarks — adding TanStack Query there just creates a
second, competing cache — and the sync engine runs at background/app level, not
in React, so hooks don't apply. Its control-plane calls (sync pull, commit,
signed URLs) go through the same contract client, injected as **`SyncDeps.api`**
rather than read from a hook; the R2 blob PUT/GET use plain `fetch` (signed URL,
no contract). Results land in Dexie, which the UI observes reactively.

In short: **component server calls → TanStack Query over `useApiClient()`;
background sync engine → the same client via `SyncDeps.api`; R2 blobs → plain
`fetch`.** All control-plane calls share the same `@stxapps/shared` contracts and
the one injected client.

### measuring a sync

A push of the `seed_plus_full` library (1,000 links, ~2,000 files) took about ten
minutes on bracemark-web and bracemark-expo alike. A stopwatch can only confirm a
number like that, so the engines carry their own instrument, and `measure:sync`
reads it alongside two more ([e2e.md](./e2e.md), _the sync leg_). Read this before
tuning anything named in _a push is chunked_ — the fan-outs, the chunk sizes, the
rate limit — because each of those comments says "a starting point" and this is the
measurement they were waiting for.

**Three instruments, one window.**

- **The engine's spans** (`@stxapps/shared` `sync/trace.ts`). Both engines time
  the same steps under the same names — `cycle`, `push.chunk`, `upload`,
  `blob.put`, `commit`, `pull`, `blob.get`, `blob.store`, one `api <path>` per
  contract-call _attempt_ — and the summary turns them into, per name, the wall
  time it owned, the work it did, and their ratio: **how many were really in
  flight**. `INDEX_CONCURRENCY` is 96; a `blob.put` row that reads 5 says
  something is holding the fan-out back, and the other two instruments say what.
  The vocabulary is listed in the module and pinned by
  `packages/web-react/src/sync/engine.spec.ts`, _the timing trace_.
- **Chrome's Network domain** (`e2e/measure/network.ts`): per request, the time
  it queued in the browser for a socket, its protocol, the sockets each host
  got, time to first byte, CORS preflights. Six sockets to R2's host with long
  queueing is HTTP/1.1's per-host cap, not the engine.
- **bracemark-api's `Server-Timing`** (`apps/bracemark-api/src/lib/server-timing.ts`):
  the session read, the Durable Object call, `r2-stat` (the commit's existence
  check, wall) beside `r2-list` and `r2-head` (the sums of its calls), signing,
  and the blob route's `r2-put` / `r2-get`. It tells a
  slow `ops/commit` apart as time in the Worker or time on the wire. A Worker's
  clock moves only across I/O, so every metric is a wait, never CPU.

**All of it is off in what users run.** Each engine holds `NO_TRACE` until a
recorder is installed: on web behind the `bracemark.syncTrace` localStorage flag
(`packages/web-react/src/sync/trace.ts`, read once per page load); on expo only in
a bundle built with `EXPO_PUBLIC_SYNC_TRACE=1`, which prints each cycle's table as
`[sync-trace]` to the log (`packages/expo-react/src/lib/sync-trace.ts`). With
`NO_TRACE`, `span` runs its body and `traceApi` returns the client it was given. The
header is on where `SERVER_TIMING` is `"1"`, which is development and staging
(`wrangler.jsonc`), not production: it would tell any client which stores a
request touched, and no client needs that.

**The trace is module state in each engine, not a `SyncDeps` field.** A trace
belongs to the engine. Overlapping callers share one cycle (`runIncrementalSync`'s
single-flight), and an import's deps or an export's deps would otherwise decide
whether the cycle they happened to join was timed.

**⚠ On bracemark-web the service worker carries the sync's GETs, and only those.**
`sw.ts` routes cross-origin requests through `NetworkOnly`, and a Serwist route
matches `GET` unless it names another method. So in a production build each api
GET (`ops/list`, `files/list`, `iap/status`) — and, before the blob route, each
presigned R2 GET — is answered by the worker, which makes the real request
itself. A `PUT` or a `POST` matches no route, and the browser sends it as if no
worker were registered. Both readings below show it: before the blob route, none
of 2,363 PUTs and 1,836 of 2,073 pull GETs went through the worker; with it, the
blob route's reads are POSTs, and none of the blob transfers did. Two
consequences for a reading. The worker's hop is part of what it carries, and the
only way to price it is a `--no-sw` run beside an allowed one — which, with the
blob route, prices a cycle's few api GETs and nothing else. And a page-level
network capture sees a worker-carried request end to end but not its wire: no
preflight, socket or protocol, which happen in the worker. The dev server
registers no worker, so a local reading has neither the cost nor the blind spot.
Nothing about this is visible in a test.

**What a reading should settle**, in the order the code suggests them. None is
established until a staging reading shows it:

1. **A preflight per PUT.** A cross-origin `PUT` is always preflighted, and Chrome
   caches a preflight per URL. Every presigned URL is unique, so the cache never
   hits, and every upload costs two round trips. Visible as `blob OPTIONS` rows in
   a `--no-sw` run.
2. **HTTP/1.1 to R2's S3 endpoint**, which would cap a host at six sockets and
   make `INDEX_CONCURRENCY` 24 effectively 6. Visible as the protocol column, the
   socket count and the queued time.
3. **The service worker's hop** (above): the sw-allowed and `--no-sw` walls side
   by side.
4. **The `tight` rate limit** (10 calls per 10 s per user and per path, so
   `files/sign` and `ops/commit` each have a bucket) and `withRetry` waiting out
   `Retry-After`. Visible as `api` spans with `status: 429`.
5. **Many cycles instead of one.** An import kicks cycles while it is still
   writing. Visible as the cycle count and the `cycle.lock` waits.
6. **Main-thread contention.** Each pulled record is its own IndexedDB transaction
   and a live-query invalidation. Visible as `blob.store` time and long-task
   blocking.
7. **The commit's server side.** Visible as `r2-stat` (before the listing:
   `r2-heads`) and `do-commit` in the api's timing.
8. **The commit's existence check on a sparse batch.** `statMany` walks R2's
   listing in key order, a page after a page within a namespace, and hands the
   rest to `HEAD`s — six at a time — once a page answers fewer than
   `LIST_MIN_HITS` keys. An import's chunks are dense, so the push legs never
   meet it. A bulk edit of N links scattered among L does: about L / 1,000 pages
   while each answers 13 or more, `HEAD`s below that, so on a large library a
   500-op commit could take tens of seconds — by arithmetic, not yet by reading.
   Visible as `r2-list` and `r2-head` on a `bulk-edit` leg's commit, at
   `--links 10000` or more ([e2e.md](./e2e.md), _the sync leg_).

Record a reading where the change it justifies is made, with the date, the
target, the variant and the machine, like the readings in
[data-lifecycle.md](./data-lifecycle.md).

**Reading, 2026-10-19 — staging, 1,000 links (2,363 files), service worker allowed
and blocked, Chrome 155 on an Apple M1 Mac, before the blob route.** It settled
1, 2, 3 and 7 and ruled out 4 and 5, and the blob route and the listing
existence check are what it justified:

|                                                        | service worker allowed | `--no-sw`                  |
| ------------------------------------------------------ | ---------------------- | -------------------------- |
| push wall                                              | 614 s                  | 628 s                      |
| upload (8 chunks)                                      | 476 s                  | 493 s                      |
| commit (8 calls)                                       | 127 s                  | 125 s                      |
| PUT time to first byte, p50 / queued for a socket, p50 | 1.0 s / 3.4 s          | 1.0 s / 3.6 s              |
| R2 protocol, sockets                                   | `http/1.1`, 6          | `http/1.1`, 6              |
| CORS preflights                                        | 2,367                  | 2,365                      |
| pull                                                   | 253 s, 8.6 GETs/s      | failed after 122 s (below) |

- **The uploads were socket-bound** (1, 2): content at 8 in flight and index at
  24 ran the same ~5 PUTs/s — six sockets over ~1.2 s per PUT and its preflight.
  The GET floor, fetched with nothing around it, levelled at 16.7/s from 12 to
  48 at once.
- **The commit was the Workers connection limit** (7): a 500-op commit was 25.6 s
  of `r2-heads`, ~19.5 `HEAD`s/s — six at a time at ~300 ms each — and its
  Server-Timing total matched the client's time to first byte.
- **The service worker's hop was noise** (3): 476 against 493 s of upload, and
  8.6 against 9.0 GETs/s before the stall below.
- **No `429`s** (4), and one cycle carried all 2,363 ops (5). `blob.store` totalled
  about a second (6); the main-thread instrument reported no long task at all,
  which this reading did not check.
- **The pool stalls, and the deadline counts the wait.** In the `--no-sw` pull all
  six R2 sockets stopped at once ~62 s in and no new connection opened for ~60 s.
  Twelve GETs that never got a socket hit `BLOB_BASE_TIMEOUT_MS`, which runs from
  the `fetch` call and so includes the browser's queue, and one failed GET failed
  the whole first sync (`BlobTimeoutError`, 496 of 2,363 stored). The same run's
  incremental push left six link PUTs queued after a failed cycle. One run of
  each, so it is not pinned on `--no-sw`.

**Reading, 2026-10-19 — the same, with the blob route** (`1f06d82`), service
worker allowed and blocked. Push and pull both ran ~3.4× faster, and what is left
is R2 itself:

|                                                 | service worker allowed | `--no-sw`       |
| ----------------------------------------------- | ---------------------- | --------------- |
| push wall                                       | 179 s                  | 188 s           |
| upload (8 chunks) / commit (8 calls)            | 156 s / 12.1 s         | 164 s / 14.2 s  |
| PUT p50 / `r2-put` mean                         | 1.04 s / 1.10 s        | 1.06 s / 1.14 s |
| PUTs in flight (content 8, index 24 configured) | 17.9                   | 17.7            |
| protocol, sockets, queued p50                   | `h3`, 1, 0.6 ms        | `h3`, 1, 0.4 ms |
| CORS preflights                                 | 10                     | 10              |
| pull                                            | 74 s, 33 GETs/s        | 73 s, 32 GETs/s |
| GET p50 / `r2-get` mean                         | 0.68 s / 0.63 s        | 0.68 s / 0.63 s |
| floor at 24 / 48 at once                        | 65 / 60 per s          | 63 / 112 per s  |
| incremental (100 links onto 1,000)              | 8.7 s                  | 9.1 s           |

- **The transport is settled.** One HTTP/3 connection carried every transfer,
  nothing waited for a socket, and ten preflights answered a 2,363-PUT push. The
  commit went from 127 s to 12 s on the listing existence check.
- **What is left is the Worker waiting on R2**: `r2-put` and `r2-get` are
  nearly all of each transfer, against tens of milliseconds of wire. Both tiers'
  buckets are in eastern North America (`ENAM`); on loopback the same calls take milliseconds. A bucket's region is fixed when it
  is created, and production's holds users' data, so that factor stays. A sync's
  time is then about objects × R2 latency ÷ fan-out, and the fan-out is the only
  factor the client owns.
- **The fan-out was the limit.** 17.9 PUTs in flight against 8 for content and
  24 for the index: the 290 content blobs — 343 B each in this library — went up
  at ~5 a second. The floor's p50 held at ~355 ms from 24 to 48 GETs at once, so
  the server was not the limit; its rate at 48 differs by run (60 and 112 a
  second) because 480 GETs at 48 wide is ten rounds, and one straggler sets the
  wall.
- **Serial seams.** Between each pair of the push's 8 chunks, a sign (~0.7 s)
  and a commit (~1.6 s) ran with no transfer in flight. The pull listed all of
  its pages (6–8.5 s) before its first GET, signed each 1,000-path batch only
  after the one before had drained, and narrowed to its slowest GET at every
  batch's end.
- **The service worker carried none of it** (above), so the two columns differ
  by noise.
- **No 4xx, no 5xx, no 429.** The api's stored invocation log for both runs —
  13,711 entries — held no blob token and no object path: `authorization` was
  masked on every PUT, a read's token rides in a body the log does not keep, and
  every blob entry's URL is the bare route. The refusal line never fired.

It justified three engine changes, in both engines, priced by the reading after
it:

- `INDEX_CONCURRENCY` 48, and content sized rather than counted: a `files/` blob
  up to 64 KiB goes at the full fan-out, a larger one waits for one of
  `FILE_CONCURRENCY` (8) slots inside it (`uploadBlobs`; the threshold's
  arithmetic is at `LARGE_CONTENT_BYTES`).
- A chunk's commit runs beside the next chunk's sign and upload (_a push is
  chunked_).
- A pull is one fan-out that signs a batch ahead (`createSignedFanOut`,
  `@stxapps/shared`), and a first sync's GETs start on its first listed page; its
  counter still waits for the whole listing before it shows a total.

Not taken: a bucket nearer its users (above), and holding small records outside
R2 — in the user's Durable Object, or packed — which would make a push or pull of
a thousand links a handful of calls, and reverses _source of truth_.

**Reading, 2026-10-19 — the same, with those three changes** (`2b19789`), service
worker allowed and blocked:

|                                    | service worker allowed | `--no-sw`        |
| ---------------------------------- | ---------------------- | ---------------- |
| push wall                          | 78.5 s                 | 77.0 s           |
| upload (8 chunks) / signs (8)      | 66.5 s / 5.4 s         | 65.2 s / 6.1 s   |
| PUTs in flight, rate               | 42.6, 35.6 per s       | 42.8, 36.3 per s |
| CORS preflights                    | 50                     | 50               |
| pull                               | 34.8 s                 | 43.7 s           |
| GETs in flight, rate               | 47.3, 65 per s         | 37.1, 51 per s   |
| floor at 24 / 48 at once           | 60 / 107 per s         | 66 / 124 per s   |
| incremental (100 links onto 1,000) | 4.6 s                  | 5.7 s            |

- **The push went from 179 s to 78 s and the pull from 74 s to 35 s**, the
  fan-out running full: 42–47 transfers in flight of 48.
- **The commits disappeared behind the uploads.** They still took 12.3 s, but
  the chunks overlapped by 10 s: the push is now its signs, its uploads and its
  last commit.
- **The listing ran inside the downloads.** The pull's download phase covered
  32.2 s of its 34.0 s, the four listing pages (7 s) among them.
- **The pull is at its fan-out's rate.** 47.3 GETs in flight over a 0.67 s GET is
  ~70 a second, and it ran 65. The floor's 0.35 s is a re-read of the same
  objects: R2 answered a first read in ~0.65 s on both runs (`r2-get`), a second
  in about half that.
- **One straggler cost the `--no-sw` pull 9 s.** Its last GET took 19.5 s; every
  other had ended at 31.9 s. A read is idempotent, so a second request for a GET
  that runs past a few seconds — a hedge — would cut such a tail. Not made.
- **What is left of the client's own seams**: the 8 signs (5.4 s, 7% of the push)
  run in line before each chunk's upload, and each chunk's upload narrows to its
  slowest PUT before the next can start.
- **50 preflights instead of 10**: 48 PUTs leave before the first preflight's
  answer is cached. 0.2 s in all.

The bulk-edit and bulk-delete legs came after it; their first staging run is what
settles 8.

**Reading, 2026-10-19 — staging, bulk edits onto 1,000 links** (`2b19789`, service
worker allowed, Chrome 155 on an Apple M1 Mac). Select all overshoots a size that
is not a whole page, so 100 and 1,000 asked were 158 and 1,058 done:

|                           | 10              | 158             | 1,058                          |
| ------------------------- | --------------- | --------------- | ------------------------------ |
| push wall                 | 4.4 s           | 10.8 s          | 37.0 s                         |
| upload / commit           | 2.2 s / 1.0 s   | 6.3 s / 3.1 s   | 32.7 s / 5.8 s (3, overlapped) |
| commit's `r2-stat`        | 0.6 s (`HEAD`s) | 2.5 s (listing) | 1.3 + 1.3 + 0.4 s (listing)    |
| pull on the second device | 3.0 s           | 5.1 s           | 20.7 s                         |

- **A bulk edit is its uploads.** 1,058 `links/` PUTs at ~1.05 s each, 40.2 in
  flight of 48: ~32 a second, 88% of the push. The commits ran beside them.
- **The existence check is not where it goes at this size**, and 8 is untouched:
  a 1,000-link library is a few listing pages, so this reading cannot show how
  the check grows with the library. One oddity to read again: the 158-edit
  commit's listing (2.5 s) took longer than each 500-op chunk's (1.3 s).

It justified `INDEX_CONCURRENCY` 96, and `LARGE_CONTENT_BYTES` halved to 32 KiB
with it so a full fan-out of small content stays the 3 MiB its deadline was sized
for (the arithmetic is at `LARGE_CONTENT_BYTES`). Not yet read: the next staging
reading prices it.

### deferred

- **R2 conditional writes** for same-file concurrent-edit detection (see
  _conflict policy_) — accepted as LWW for now.
- **True-conflict winner: local-wins vs server-wins** (see _a sync cycle_) — when
  reconcile finds both sides changed a path since the base, local-wins (upload)
  clobbers the other device's committed edit; server-wins (download) discards the
  user's unsynced edit. Open product call (the shipped engine picks local-wins —
  never silently discard the user's unsynced work); conditional writes make it a
  prompt rather than a silent choice.
- **Client-side orphan GC** (see _multi-file consistency_) — quota bounds growth
  until then.
- **Offline content pinning / prefetch** (see _data model — metadata vs.
  content_) — let users mark bookmarks "available offline," or prefetch page copies
  on idle, so a never-opened page copy isn't missing offline.
- **Local content-cache eviction** — lazily fetched content/page-copy blobs
  accumulate in Dexie against the IndexedDB budget; an LRU eviction of _content_
  (metadata is never evicted) keeps it bounded. Distinct from server-side orphan
  GC above.
- **Op-log compaction alarm** — the DO's `alarm()` is the natural driver; see the
  class comment in `user-data.ts`.
- **Manual "repair sync" control** — a user-facing button that forces the
  download-authoritative fallback (see _fallback full sync_) on demand, for the
  rare case where incremental sync is missing data — e.g. an `object-without-op`
  left by a device that never returned to commit. The mechanism already exists;
  this just exposes a trigger, and doubles as a first-line support tool.
- **Server-side op coalescing** — when a path has several ops since the client's
  cursor, return only the latest (a `put` collapses earlier `put`s; a `delete`
  collapses everything prior for that path). Efficiency only, not correctness: the
  client already collapses by path when it partitions in _a sync cycle_, so it
  never double-downloads — this just trims op-list payload and pagination
  round-trips, and mainly for the _medium gap_ (far enough behind to have
  duplicate paths, not far enough to hit fallback). Trades the cheap
  `updated_at > ? LIMIT` scan for a heavier `GROUP BY path` query that interacts
  with the `(updatedAt, path)` keyset, so measure before adding. Distinct from the
  retention-trimming op-log compaction above.
