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
- the **sync cursor** — the compound `(updatedAt, path)` of the newest op/file
  the client has reconciled, stored as `syncCursorUpdatedAt` + `syncCursorPath`
  (the high-water mark for the next incremental pull — see _the sync endpoint_);
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
POST /v1/ops/commit    record committed mutations (batched; HEADs puts, deletes objects) (→ the three flows: push)
GET  /v1/files/list    fallback R2 listing, paginated (download-truth) (→ fallback full sync)
POST /v1/files/sign    mint presigned R2 URL(s); op: 'put' | 'get' (→ authorization & quota)
```

**Every endpoint is bounded — never one-path-per-call, never unbounded.** The two
shapes bound differently: the **reads** (`ops/list`, `files/list`) return many and
**paginate** under a `limit`/page size, so a client pages forward with a cursor
rather than pulling an open-ended response; the **writes** (`ops/commit`,
`files/sign`) accept many and **batch** under a `.min(1).max(1000)` array, so a
first-sync push of thousands of files is a handful of round trips, and a request
over the cap `400`s at the contract before any work runs (the abuse gate). The
batch caps for the two writes are the same number (`1000`).

All four live in `apps/bracemark-api/src/routes/sync.ts` (each behind `requireAuth`).
(One data-plane endpoint sits deliberately OUTSIDE this control plane:
`POST /v1/data/delete-all` wipes the whole namespace — op log, quota map, R2
prefix — in one authed call; other devices then converge through the wiped-log
fallback row below. See [data-lifecycle.md](./data-lifecycle.md).)
The op-plane endpoints (`ops/list`, `ops/commit`) are thin passthroughs to the
user's Durable Object; the file-plane logic — paging R2, the quota gate, the
presigner — is in `services/sync.ts`. The shared contracts are in
`@stxapps/shared` (`sync/endpoints.ts`).

The blob bytes themselves never touch the API — the client PUTs/GETs R2 directly
over a `files/sign` URL. So `files/sign` is the **only** endpoint on the hot path
of bulk data, and it's deliberately a thin envelope check (ownership + quota), not
a content gateway. The signed URL is an **AWS SigV4 presign of R2's S3 endpoint**
(`r2/presign.ts`), because the Workers R2 _binding_ can read/write objects
from inside the Worker but can't mint a URL the browser can use directly; the S3
access keys come from per-env secrets (`R2_*` in `wrangler.jsonc` / `lib/env.ts`).

**Local dev is the one place the bytes do pass through the api.** miniflare's
emulated R2 has no S3 endpoint to presign, so under `wrangler dev` `files/sign`
returns URLs to an in-Worker blob proxy instead (`r2/local.ts` builds them,
`routes/local-r2.ts` serves them), gated on the placeholder `R2_ACCOUNT_ID` that
only the `development` env carries — staging and production presign R2 directly
and the route 404s there. Those URLs take their **origin from the incoming
request**, never a constant, because one `wrangler dev` answers on both
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
from an R2 listing**, so a DO rebuild or a fallback would have no valid seq to
resume from. An R2 timestamp always can: the newest `LastModified` in a listing
_is_ the cursor. A DO rebuild or seq reset therefore can't invalidate a client
cursor, and a wiped log is rebuildable from R2.

### schema changes — the client is greenfield, the server is not

Three shapes above can move, and they do **not** obey the same rule.

**On a device nothing has shipped, so the client stores are edited in place.**
Dexie's `version(1)` (`packages/web-react/src/data/db.ts`), the expo-sqlite DDL
(`packages/expo-react/src/data/db.ts` — idempotent, per the greenfield
no-migrations policy in [architecture.md](./architecture.md)) and the R2 payload
shapes above (`packages/shared/src/sync/`) all change by **rewriting them**:
change the shape, recreate the dev database (delete the app, clear its data), add
no migration step. Compatibility with a past no user has is cost with no
beneficiary — [share-sheet.md](./share-sheet.md) reaches the same answer about the
outbox file, for the same reason.

**⚠ The client leaves this regime the day the first build reaches a user, and
it has to be ready before that day, not on it.** From then on, "delete the app,
clear its data" stops being a dev chore. It deletes a library that, with the
server unreachable or gone, exists nowhere else
([offline-mode.md](./offline-mode.md), _the promise_). The three client shapes
leave on different terms:

- **Dexie (`bracemark-data`) and the raw session database
  (`bracemark-session`).** Append `version(N)` (with an `upgrade()` for any
  data reshape); never edit a shipped version, and bump `DATA_DB_VERSION`
  (`db.ts`) with every Dexie `version(N)` — the newer-schema check compares
  against it. The `versionchange` handler every tab needs is in place on both
  databases (`data/update-required.ts`): the event fires in the _old_ tab, so it
  had to ship before the first `version(2)`, and it has. The mechanics and the
  failure modes are in [offline-mode.md](./offline-mode.md), _version skew_.
- **expo-sqlite.** Replace the idempotent DDL with numbered migrations keyed
  on `PRAGMA user_version`, run on open before first use, append-only like the
  server's. One process opens the database at a time (the iOS share extension
  writes its outbox file, not the database; [share-sheet.md](./share-sheet.md)),
  so there's no multi-tab counterpart to `versionchange`. The migration
  runner can land with the first migration; it's the _policy_ that has to
  change at launch. The comments at the top of
  `packages/expo-react/src/data/db.ts` and the "greenfield no-migrations
  policy" in [architecture.md](./architecture.md) go in the same change.
- **R2 payloads** are already built to cross versions. Every entity is a
  `z.looseObject` (`packages/shared/src/sync/entities.ts`), so an older client
  passes fields it doesn't know through unchanged, and the blob frame's version
  byte makes an unknown layout fail loudly rather than misread
  ([crypto boundary](#crypto-boundary--what-the-server-still-learns)). After
  launch, what changes is only the licence to _rewrite_ a shape: fields are
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
  same scheme as tag/list order) so reordering a pin rewrites only that one pin.
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
  layer **above** sync.

### the three flows

**1. First sync (after sign-in).** Pull the full set of metadata/tag/list paths,
download + decrypt each, build the local index. Content/page copies are _not_
downloaded here — they come on demand. For 5 000 bookmarks at ~500 bytes of
metadata each that's ~2.5 MB — manageable. Set the cursor to the **newest
`(updatedAt, path)` among the files listed** — the same reconstruction the
fallback full sync does from its listing.

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
minted at PUT time and could otherwise land behind a cursor already issued.

**3. Push (new / edited / deleted entity).** Write to the local store first and
enqueue the mutation in the pending-ops queue, then drain the queue:

```
create / edit a bookmark:  upload content files first, metadata file LAST
delete a bookmark:         delete metadata first, then content files
```

The commit protocol (3 round-trips), **batched** across files — `files/sign` and
`ops/commit` each take an array (up to 1000), so a multi-file create or a
first-sync push is a handful of round trips, not one per file:

1. `POST /v1/files/sign` with `{ op: 'put', paths: [...] }` to mint signed upload
   URL(s) (the Worker verifies each path is under `/users/{authedUid}/` and checks
   quota — see _authorization & quota_);
2. encrypt and PUT each blob directly to R2 via its signed URL;
3. `POST /v1/ops/commit` with `{ ops: [{ op, path }, …] }`; for each `put` the
   Worker **`HEAD`s the object** — which both confirms it exists in R2 and reads
   R2's authoritative `LastModified` — records the op with that timestamp (the DO's
   `commitOps`, which also stores R2's reported object size in the per-user quota
   map). The per-put HEADs fan out in parallel; one DO RPC then writes the whole
   batch. The Worker returns `{ results: [{ path, updatedAt }, …], failed: [{ path,
reason }, …] }` — `results` for the committed ops, `failed` for the refused ones.
   The `HEAD` does double duty: existence check _and_ the single clock that
   incremental and fallback both compare against.

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
> One pipeline pass signs, uploads, and commits a **single chunk** (bounded by the
> smaller of the `files/sign` and `ops/commit` caps), rather than signing
> everything up front: that keeps each presigned PUT's mint-to-PUT latency inside
> its **own** chunk's upload window. For KB-sized index blobs that is far under
> the 5-minute TTL on a push of any size. A `files/` **content** chunk genuinely
> can outlive it on a slow uplink — so the expiry is absorbed **per blob**: an
> expired-URL PUT (R2 answers 403) fails only its own op, the chunk still commits
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
>   know we never sent — on a large failed chunk that is up to a thousand
>   guaranteed `no_object` entries per cycle.
> - **The metadata phase is HELD for the rest of the cycle if any content upload
>   failed** — otherwise a puller could land metadata whose content `404`s, the
>   exact breach the content-before-metadata order exists to prevent. Held
>   _wholesale_ because the engine is schema-blind: it cannot tell which metadata
>   is safe. The held ops just stay queued and the next drain retries both halves
>   in order.
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
`updatedAt` and advances the sync cursor to it — never the local clock. Every `put`
is therefore stamped on R2's clock — the same value the client stores locally and
the fallback listing reads back — so there is no cross-device skew to reconcile
for any write that has a surviving object. (A `delete` op has no surviving object
to `HEAD`, so its `updated_at` is the **deletion commit time** — a `deletedAt` —
on the Worker's clock rather than R2's; the `updated_at` column thus mixes the two
clocks. That mismatch is harmless because paths are **immutable random ids**: a
path's life is only ever `put`…`put`…`delete`, never `delete`→`put`, so the two
clocks never have to order a put against a delete on the same path, and nothing
can be resurrected by skew. The one exception is deliberate: local-wins reconcile
re-`put`s a path whose `delete` another device already committed — keeping the
unsynced edit is the point — and that re-put's commit `HEAD` is stamped after the
delete in real time, so it orders after it up to Worker↔R2 clock skew.)

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
> **returning the lifted stamp** — it is what the committing client stores locally
> and advances its own cursor to, so client and log never disagree.
>
> The consequences are benign by construction. Per-path order is preserved: the
> prior op for a path is already in the log, so the clamp only ever lifts the new
> one **above** it. Within one batch the shared floor is fine: the batch commits
> atomically under the serialized DO, so a puller sees all of it or none, and the
> `(updatedAt, path)` tiebreak orders its ties. And a stamp nudged past R2's real
> `LastModified` costs at most **one redundant, idempotent re-download** the next
> time a fallback listing compares the two. An in-order commit is untouched — the
> clamp only engages on the race. Coverage:
> `apps/bracemark-api/src/do/user-data.spec.ts`.

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
`hasMore` is true. (`sincePath` is omitted only while the cursor is still the
seeded-new-account `(0, '')`; the server treats a missing `sincePath` as the low
sentinel, so the scan includes every op at that millisecond.) This keyset query and the `oldestUpdatedAt` / `newestUpdatedAt`
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
5. Advance the cursor to the newest `(updatedAt, path)` seen across the whole cycle —
   **including your own just-committed uploads**, so the next cycle doesn't
   re-fetch them.

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
> record) — both orders end with the local write intact. The re-read is per
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
> **Both engines carry all three guards**, and they land differently per platform.
> web-react re-reads the queue inside a Dexie multi-store transaction
> (`applyDeletes` / `putPulled`); expo-react composes the read into the write's own
> synchronous sqlite transaction (`item-store`'s `putItemsUnqueued` /
> `deleteItemsUnqueued` over `pending-store`'s `queuedPathsTx`), and clears with a
> `(username, path, write_id) IN (VALUES …)` predicate evaluated inside the DELETE
> — so it needs no read-then-filter step at all. It is one DELETE per batch of
> ops, not one per op, because a statement per op cost ~0.6 s of JS thread per
> 1,000-path commit together with the restamp beside it
> ([data-lifecycle.md](./data-lifecycle.md), _readings — expo_). expo's `write_id` is `NOT NULL` where web's is a
> plain required field: neither store validates, so in both cases it is the type
> system that has to stop a future writer enqueueing an untagged row.
>
> Regression coverage for all of the above:
> `packages/web-react/src/sync/engine.spec.ts`.

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
consequences: the client **can't stop early** (the newest `updatedAt` can sit on
any page, since key order ≠ time order — see the cursor note below), and the
listing is **not a snapshot** (pages span concurrent writes). The non-snapshot is
safe here precisely because fallback is download-authoritative and
`updatedAt`-compared: anything that changes mid-listing carries a fresh
`LastModified` and is simply caught on the next sync.

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

After reconciling, set the cursor to the **newest `(updatedAt, path)` among the
listed files — taken across _all_ pages**, not just the last one (R2 returns key order,
not time order, so the newest timestamp can land on any page) — reconstructed
straight from R2, with no dependence on the op log, so the next visit resumes
normal incremental sync. In the `since > newestUpdatedAt`
case this lowers the cursor _below_ the stale value it had: R2 is the source of
truth, the old cursor pointed past what exists, so it's reset down to reality.
This is the resume a `seq` cursor couldn't give you: there is no sequence number
to recover from an R2 listing, but the newest `LastModified` always is one. (A delete that happened _after_ that
newest surviving timestamp leaves no object to carry it, but it was already
reconciled by the download-authoritative pass above, so the cursor needn't
account for it.)

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
  DO log write: a `put` is `HEAD`-verified to exist before its op is logged, a
  `delete` removes the R2 object before logging the delete. This is the
  `op-without-object` invariant (see _source of truth_), and **only the server
  can own it** — the client can't write the op-log at all, and can't DELETE R2
  directly (`files/sign` mints only PUT/GET). Both halves happen inside
  `commitOps` (`services/sync.ts`): `deleteMany` R2 → `HEAD` puts → one DO
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
  3. **It isn't in the upload path.** Content is PUT client→R2 over a presigned
     URL out of band; the server only learns of it at commit-time `HEAD`.

A is the **primitive B is built on**: because every commit is R2-first/log-last
and the DO write is atomic, each phase is durable as a unit before the next
begins. That durability is exactly what lets the engine sequence the four phases
and trust each is real before opening the next. The engine realizes B in
`pushPending` (`packages/web-react/src/sync/engine.ts`), and two things there are
**load-bearing for correctness**, not just tidiness:

- **sequential `await` between phases** — the durability-before-next-phase
  guarantee _is_ this ordering; and
- **single-flight per account** (`inflightSyncs`) — two concurrent drains would
  interleave phases and break the global order.

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
client_.

Neither constraint can be moved to the other side. Pushing B server-side would
require exposing the reference graph to the server (weakening E2E opacity) and
**still** wouldn't buy atomicity — R2 has no multi-object transaction and the
uploads are out of band — so the crash windows would remain. The current
placement (A = server/per-commit, B = client/cross-commit) is the minimal correct
arrangement.

### conflict policy

File-level **last-writer-wins**, which is cheap because granularity is one entity
per file. Accepted tradeoff, written down so it isn't a surprise:

> Two devices editing the **same** file concurrently → the later PUT wins and the
> earlier edit is lost silently.

For a single-user, multi-device manager this is acceptable. The cheap future
upgrade is **R2 conditional writes** (`If-Match` on the etag, or `If-None-Match:
*` for create) baked into the presigned URL, so a stale write `412`s and the
client re-pulls before retrying. Deferred, not designed away.

### crypto boundary & what the server still learns

Every blob is AES-256-GCM under the single data key derived from the account DEK
(see [account.md](./account.md)); `@stxapps/web-crypto`'s `encrypt` uses a
**fresh random 96-bit IV per call**, so one key for all files is safe. Door
changes / password changes re-wrap only the 32-byte DEK and **never re-encrypt
data**, so the sync layer is entirely oblivious to them.

**Blob wire format.** Every R2 object is the binary frame
`[version(1) || iv(12) || ciphertext+tag]` — packed/unpacked by `blob.ts` in the
crypto packages (`@stxapps/web-crypto` / `@stxapps/expo-crypto`, next to the
AES-256-GCM primitive it wraps; the sync engine is the caller). The constants
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

Even with E2E, the server still learns the **number of files, each file's size,
its timestamps, and access patterns** (which blobs are fetched when). It does
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
(`do/repositories/file-sizes.ts`): `path → size`, set from the commit `HEAD` on
`put`, read-and-subtracted on `delete` (a delete has no object left to `HEAD`, so
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
