## data lifecycle — import, export, delete all data & delete account

The four whole-library actions of the Settings → Data / Account sections and
why each is shaped the way it is. They operate at a different altitude than the
sync plane ([local-first-sync.md](./local-first-sync.md) — individual paths)
and the account plane ([account.md](./account.md) — keys and credentials).

**Where each runs is forced by E2E encryption, not preference.** Import and
export are **client-only** — the server holds only ciphertext, so it _can't_
serialize a bookmarks file or parse one; the plaintext work has to happen where
the key is, and no plaintext ever leaves the device (export writes a local
file, import reads one — the only server traffic is the ordinary sync plane).
Deletion is the one lifecycle action the server _can_ do better than a client
(the envelope — the key prefix — names what to delete, no content knowledge
needed), which is why delete-all is a server endpoint while its predecessors in
the Gaia era were client loops.

The two destructive actions in one view: **delete all data** wipes the bytes
and keeps the identity; **delete account** takes both.

|                      | Delete all data (Settings → Data)               | Delete account (Settings → Account)                     |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------- |
| R2 + op log + quota  | wiped                                           | wiped (same service)                                    |
| local store          | synced stores wiped; session/device stores kept | everything wiped (full `clearData` via sign-out)        |
| account rows / doors | untouched                                       | deleted — doors gone = the cryptographic kill           |
| sessions             | kept (you stay signed in)                       | all revoked                                             |
| subscription         | untouched                                       | must not be live (409 gate); canceled-entitled forfeits |
| username             | untouched                                       | tombstoned — occupied forever (loosenable later)        |
| guard                | confirm checkbox                                | fresh password-signed proof + bearer token + checkbox   |
| undo                 | none                                            | none                                                    |

### export — read the local store, apply policy once, serialize per format

`web-react` `data/export-all-data.ts` (behind `useExportAllData`) orchestrates;
the three interop serializers are pure functions in `@stxapps/shared`
(`export/`). Four formats, one deliberate asymmetry:

- **bracemark** — the complete backup: a zip of `manifest.json` + `items.jsonl`
  (raw `{path, data}` entities) + `files/{id}` (raw decrypted blob bytes). The
  **only format that round-trips**, and the only one that includes Trash — a
  backup that silently drops data isn't one.
- **netscape** (browsers, LinkWarden, Karakeep), **csv** (Raindrop.io),
  **text** (URL per line) — the interop formats. Trash is excluded here:
  importing deleted-pending links into a browser as live bookmarks is never
  wanted.

Export reads the **local** store (unsynced edits on this device are included)
after a pre-export sync refresh; a failed refresh downgrades to a warning —
"this is this device's copy" — rather than aborting. The policy that spans all
formats is decided once in the orchestrator: **locked lists are excluded**
(the lock provider's coverage set, descendants included; excluded links drop
with their pins/extractions/files, and the list entities drop too — a hidden
list's _name_ is as sensitive as its contents; the UI warns with the count),
and a dangling `listId` files under My List, the read layer's reconciliation
spirit.

### the bracemark zip is platform-split — and mobile has ceilings web doesn't

Both platforms read and write the same **layout** (`manifest.json` +
`items.jsonl` + `files/{id}`), so a backup made on either imports on the other.
That layout is **one definition, not a convention both sides honor**:
`@stxapps/shared` `data/backup.ts` owns the format id and version, the entry
names, the manifest build/parse, the `items.jsonl` line shape and its
per-namespace schema gate, and the referenced-blob walk. It lives in `data/`
rather than `export/` or `import/` because those two namespaces are the
**interop** ones (netscape/csv/text) — a round-trip contract belongs to neither
direction — and because the cross-platform round trip is the whole point:
a `BRACEMARK_BACKUP_VERSION` bump landing on web alone would produce archives
expo's importer accepts and misreads. Bump it once, both platforms move.

The zip **container library** differs, and not by preference:

- **web** — `@zip.js/zip.js`. Streams straight to disk through the File System
  Access API (`showSaveFilePicker`, claimed before the long phases while the
  click's user activation is alive), so an archive larger than memory never
  materializes as one Blob, and zip64 engages automatically.
- **expo** — `fflate`'s `zipSync`/`unzipSync`. zip.js is not portable to
  Hermes: its codec pipeline is built on `CompressionStream`/
  `DecompressionStream`, `TransformStream`/`ReadableStream`/`WritableStream`, a
  WASM module, and Web Workers — **none of which exist on React Native**. This
  isn't a polyfill away; it's the whole architecture of the library.

fflate is the right pure-JS choice (jszip is strictly worse on size, speed, and
peak memory, and no pure-JS zipper writes zip64). But it emits a **classic
zip32 end-of-central-directory and no zip64**, which puts two hard ceilings on
the mobile backup that web doesn't have — and fflate range-checks **neither**:

> Feeding `zipSync` 70 000 entries writes `70000 & 0xffff` = **4 464** into the
> 16-bit count field and returns an archive that reads back _clean_, with
> 65 536 files silently missing. In the one format that's supposed to
> round-trip.

Both ceilings sit **inside what the paid plans sell** (`maxFiles` 200 000,
`maxBytes` 5 GiB on Plus / 20 GiB on Pro — `@stxapps/shared` `iap/plans.ts`),
so this is reachable rather than theoretical. `expo-react`
`data/export-all-data.ts` therefore asserts them (`assertZipWritable`, before
`zipSync` touches anything) and fails with a user-facing `ExportTooLargeError`
pointing at the web app. **Refusing to write a backup is always better than
writing one that quietly drops half the library.**

|              | web (zip.js) | expo (fflate)            |
| ------------ | ------------ | ------------------------ |
| peak memory  | ~one blob    | whole archive, ×2        |
| zip64        | automatic    | **no** — zip32 only      |
| max archive  | 20 GiB+      | **4 GiB** (guarded)      |
| max entries  | unbounded    | **65 535** (guarded)     |
| write target | disk stream  | cache file → share sheet |

The **read** direction is healthier than it looks: fflate _does_ parse zip64
(the extra-field sizes and the zip64 EOCD locator), so a web-made oversized
backup isn't rejected on format. The wall there is memory — the whole archive
becomes one `Uint8Array`, then `unzipSync` expands it — and that fails loudly,
so it needs no guard of its own.

**Upgrade path — a native zipper, not fflate streaming.** fflate's push-based
`Zip`/`Unzip` API paired with `expo-file-system`'s `FileHandle.writeBytes()`
would fix peak memory and _nothing else_: the zip32 ceilings are a property of
what fflate emits, not of how it's fed. The move that actually reaches parity is
native — `react-native-zip-archive` (a TurboModule wrapper over minizip on iOS
and zip4j on Android; `zip(paths, target)` / `unzip` / progress `subscribe`), or
a `BracemarkZip` module in the `BracemarkCrypto` pod. That also fits this platform
better than web's: bracemark-expo already stores blob content **decrypted on disk**,
and `BracemarkFileCrypto` already exists precisely so file bytes never enter the JS
heap — a native zipper is that same path-to-path move one layer up, where
pushing every byte back through Hermes would undo it. Three things to settle
before committing:

- Entry names come from **basenames**, so the export needs a staging directory
  mirroring the zip layout (disk ×2 — cheap next to RAM ×2).
- Import extracts to a directory, but landing the bytes still pulls them through
  JS unless `bulkWriteEntities` grows a **path-based** content variant.
- zip64 follows from the underlying native libraries but isn't documented by the
  wrapper — **verify empirically** before relying on it.

Worth weighing against a product answer: a 20 GiB Pro backup lands in the cache
dir (subject to iOS eviction) and is then _copied_ by the share sheet, so the
top end may simply be **desktop-first backup, interop formats on mobile** —
a decision to make before either port.

### import — detect the format, land through the write edge

`web-react` `data/import-all-data.ts` (behind `useImportAllData`), the write-side
mirror: one entry point takes the picked file, detects the format, and writes
through the normal write edge (`bulkWriteEntities`) — so the pending-ops queue
carries an import to the server **exactly like any other local edit**, and a crash
mid-import loses nothing already written. Detection is two-layered
(`@stxapps/shared` `import/detect.ts`): zip magic first (a bracemark backup is
bytes; a zip _without_ `manifest.json` has its `.html`/`.csv`/`.txt` entries
parsed and concatenated — Pocket's shutdown export is a zip of `part_*.csv`),
then a content-first text sniff (filenames only break ties — files get renamed
to `.txt` in transit, and a misroute degrades gracefully to the URL-extracting
text parser).

Both halves land through **one projection** — `import/project.ts`
`projectImportedLinks` — which turns parsed rows into the entities to write:
list/tag resolution, the deliberate-vs-provisional title split, custom-image
blobs, pin ranks. It's pure and shared, taking `newId` as an argument like the
resolvers, because every one of those is a **user-visible behaviour that must be
identical on web and mobile**; only the store reads, the chunked writes, and the
progress ticks stay in the two orchestrators.

The policy, decided once:

- **Interop imports dedup by canonical URL identity** (`canonicalUrlKey`, the
  same key behind the quick-add duplicate warning) — against the library _and_
  within the file; skips are reported, never errors.
- **The bracemark backup merges skip-existing by path** — a path already in the
  local store is never touched, so a restore can't clobber newer local edits.
- **The plan's link cap is enforced up front**: if the surviving new links
  would pass `maxLinks`, the import fails _before anything is written_
  (`ImportQuotaError`). This is one of the places that enforce the cap at all —
  it is client-side (see [iap.md](./iap.md), _enforcement_), so `files/sign`
  would accept an over-cap import without complaint. Refusing the whole file
  rather than importing to the cap and truncating is the honest reading of the
  request: a partial import is indistinguishable from a corrupt one at the far
  end, and the user can split the file or upgrade.
- A file-carried title is **provisional**: it seeds `extraction.title` (which
  extraction may later upgrade), never `customTitle` — unless the source marks it
  user-authored, which only the Brace.to export does today (below).
- Folder paths **find-or-create lists** by case-insensitive name walk; without
  the `nestedLists` entitlement a nested path flattens to one root-level list.
  Trash never matches a folder name.

Only the platform-bound half of that lives in each orchestrator (the store
reads, the zip library, the file API). The rest is shared, so the two can't
drift: the archive contract is `data/backup.ts` (above), the outcome/progress
vocabulary and the quota gate are `data/import-run.ts`, the format→parser
dispatch is `import/parse.ts`, the rows→entities projection is
`import/project.ts`, and the folder/tag find-or-create walks are
`import/resolve.ts` — the last two take `newId` as an argument, since id minting
is the one genuinely platform-specific piece (`web-crypto` vs. `expo-crypto`,
neither reachable from `shared`).

### importing from Brace.to

Brace.to is this project's predecessor, so its export is the one interop input
that is a **foreign app's whole backup** rather than a bookmarks file: a `.txt`
holding a pretty-printed JSON array of `{path, data}` — a raw dump of its Gaia
files across six path families (`links/`, `sslts/`, `pins/`, `tags/`,
`settings…`, `images/`). Import only; nothing exports _to_ Brace.to.

It gets its own parser (`import/brace.ts`) rather than a tolerant reading of the
text one because three properties of that layout make URL-scraping actively
wrong:

- **history.** A Brace id is `<addedDT>-<r4>-<r4>` with an optional fourth
  `<updatedDT>` segment, and an edited link keeps _every_ revision as its own
  file. They share a "main id" (the first two segments); only the greatest
  `updatedDT` is live. Import them all and a much-edited link lands five times.
- **indirection.** A link's list is whatever its newest `sslts/` entry says —
  not the `listName` in its own path, which is only where it was first filed.
- **opaque names.** The `<listName>`/`<tagName>` path segments are ids; the
  display names live in the newest `settings…` file's `listNameMap`/
  `tagNameMap`.

Detection is a **structural probe** over the head of the file (a leading `[`
then a `"path"` key naming one of the six namespaces), not a `JSON.parse` —
detection runs on every import and this file can be tens of MB. It is checked
_before_ the Netscape `</a>` test, since a stored page title can contain any
markup the page's `<title>` did. This ordering is what closes a silent failure:
Brace names its export `.txt`, so it used to sniff as plain text and the URL
regex mined the raw JSON — every dead revision, every `extractedResult` image
URL, every favicon — producing a plausible-looking mess rather than an error.

What crosses, and what deliberately doesn't:

| Brace.to                             | Bracemark                                     |
| ------------------------------------ | --------------------------------------------- |
| `url`, `addedDT`, id's 4th segment   | `url`, `createdAt`, `updatedAt`               |
| `custom.title`                       | **`customTitle`** — deliberate                |
| `extractedResult.title`              | `extraction.title` — provisional              |
| `custom.image` (`cdroot/images/…`)   | a `files/{id}.enc` blob + `customImageId`     |
| list `My List` / `Archive` / `Trash` | `MY_LIST_ID` / `ARCHIVE_ID` / `TRASH_ID`      |
| any other list                       | folder path of display names, find-or-created |
| tags (ordered by rank)               | tags, find-or-created                         |
| pins (LexoRank)                      | pins, re-ranked into this library's keyspace  |
| `extractedResult.image`/`favicon`    | **dropped**                                   |
| `decor`, every non-name setting      | **dropped**                                   |

`custom.title` → `customTitle` is the **one exception** to "a file-carried title
is provisional", and it earns it: Brace draws the deliberate/discovered line in
exactly the same place we do, so the distinction survives instead of being
flattened. `extractedResult.image` is dropped because it's a remote URL while
our `extraction.imageId` is a _downloaded_ blob — and fetching at import would
announce the user's whole library to every host in it. Writing no facets leaves
each link pending, so our own extractor derives a real image and may upgrade the
title. Settings beyond the two name maps are another product's preferences, and
`doExtractContents` is worse than noise: it's a privacy consent, which has to be
given here rather than inherited.

The system lists are carried as **named ids, not matched names**
(`ImportedLink.systemList`): resolving `['Archive']` by name would mint a
duplicate on an account whose Archive has been renamed, and `ListResolver`
deliberately refuses to match "Trash" at all — right for a bookmarks folder with
that name, wrong for a real one. Brace's mobile export writes an absolute
on-device path for image blobs instead of the `images/<fname>` key its own
importer expects; we re-key off the `images/` tail so a phone-made export isn't
silently stripped of every custom image.

Custom-image blobs are written **before** the links that name them (content
before metadata — a run that dies between the two leaves an unreferenced blob,
never a link pointing at bytes that never arrived), and stored **verbatim**: a
restore or migration keeps what it's given, and only a fresh pick in the editor
goes through `resizeImage`. The whole export is one JSON string parsed at once —
the same in-memory ceiling the bracemark backup has on mobile, failing loudly
rather than guarded, so a very large library wants the desktop app.

### delete all data — one server-side wipe, not a client delete loop

`POST /v1/data/delete-all` (contract in `@stxapps/shared` `data/endpoints.ts`,
route in `routes/data.ts`, logic in `services/sync.ts` `deleteAllUserData`).
The old Gaia-era client enumerated fpaths and deleted file-by-file because the
server couldn't be trusted with anything and had no bulk delete. Neither holds
now, and the client-driven loop is wrong on its own terms:

- **it can only delete what it knows about.** Orphans — `object-without-op`
  leftovers, blobs another device pushed that this one never pulled — survive
  it. The server sees the whole `/users/{uid}/` prefix; no client does.
- it would bloat the op log with thousands of `delete` rows and churn the
  pending queue through the engine's single-flight machinery, for minutes
  instead of seconds.

The server needs no content knowledge to do this (everything under the prefix
goes), so it doesn't strain the blind-broker stance — the envelope, not the
ciphertext, names what to delete.

**Ordering: DO first, R2 second.** This is the op-without-object invariant
("the log may lag R2 but must never point ahead of it") read in the delete
direction. Wipe the op log + quota map first (one `wipeAll` RPC — the DO's
serialized SQLite); then page `list()` + `delete()` over the R2 prefix
(1000-key pages, one subrequest each — a 100k-object library is ~200
subrequests in one invocation). A crash between the halves leaves only
objects-without-ops, which the fallback listing heals; the reverse order would
leave surviving put-ops 404ing every puller. Every step is idempotent, so the
recovery story is: the endpoint failed visibly → the user clicks again.

**Multi-device convergence is free — no epoch, no tombstones, no new sync
machinery.** The wiped op log answers the next incremental pull with `null`
bounds, which is already a routing row in the sync design: _cursor set, bounds
null → download-authoritative fallback_. The fallback lists the (now empty) R2
namespace and deletes every local path with no pending op. The one edge:
a device holding **unsynced pending ops pushes them back** (local-wins — the
same policy as every fallback, per "never silently discard the user's unsynced
work"). Accepted and written into the UI copy ("changes that haven't synced yet
may sync back afterward").

**The deleting device** (`web-react` `data/delete-all-data.ts`, over the
`useDeleteAllData` hook):

1. `awaitInflightSync` — wait out any in-flight cycle **without starting one**
   (a cycle that already read the pending queue could re-push ops after the
   wipe), then `clearPendingOps` — this device's unsynced changes are abandoned
   on purpose (pushing them first is work the wipe immediately undoes).
2. Call the endpoint. Nothing local is touched until the server confirms.
3. Wipe the local **synced** stores: `items`, the decode cache, and `locks`
   (they guard lists that no longer exist — the same reset sign-out applies).
4. `seedNewAccount` — cursor back to `(0, '')` with `firstSyncDoneAt` now.
   Semantically exact: an empty local store _is_ the complete snapshot of the
   wiped namespace, the same reasoning that lets create-account seed instead of
   pulling.

What survives, and why: the **session** (staying signed in is the point — this
is the "start over" action, not the "leave" action), the **cached subscription
status** (entitlement is untouched), and **`localSettings`** (theme/layout
device overrides are this device's preferences, not "your data"; the synced
`settings/general.enc` they override _is_ wiped). This is `clearData` minus the
identity/device stores — the two teardowns are cross-referenced in
`clear-data.ts` and must stay aligned when stores are added.

### delete account — the full teardown

`POST /v1/auth/delete-account` (contract beside the other auth endpoints,
service in `services/account.ts` `deleteAccount`). "Deactivate" — a flag that
keeps the ciphertext — was considered and rejected: in a zero-knowledge system
an unused account is already inert (no email, no public surface, only the
key-holder can ever touch the data), so a deactivation flag stops nothing,
while retaining data the user asked to remove violates the privacy stance. And
"no undo but data kept" is the worst combination of properties — can't come
back, _and_ not deleted. So the account action is deletion, done properly.

**Double guard.** The route requires the bearer token (names the account) AND
a fresh signed proof (`action: 'delete-account'`, the same
`verifyAuthProof` machinery as sign-in) — the user re-enters their password,
the client unwraps the DEK and signs. A stolen session token alone can never
erase an account. The service then binds the proof to the session (the signed
username must resolve to the authed userId — a valid proof for account A on a
session for account B dies) and runs the same load-bearing check as sign-in:
the proof's `publicKey` must equal the **stored** credential.

**Subscription gate.** 409 `subscription_active` while the subscription would
keep billing — `status === 'grace'` (dunning: the provider is still retrying
charges) or `willRenew`. Cancellation happens in the Paddle portal
(`POST /v1/iap/portal`), never inside the deletion call — deletion must not
mutate provider state. A **canceled-but-still-entitled** subscription passes:
billing already ended, and holding deletion hostage until the paid period runs
out would be hostile; the remaining time is forfeited (the UI says so). The
client pre-warns from the cached entitlements read, but the server check is
the gate.

**Teardown order — every crash window is finishable by retrying with the
still-live session** (which is why sessions go last), and every step is
idempotent:

1. **Wipe the data plane** — the same `deleteAllUserData` as delete-all.
2. **Tombstone the username** — `deleted_at` set on the directory row, row
   kept. From here sign-in is already refused (opaquely — a tombstone answers
   exactly like a name that never existed on the pre-auth door fetch and
   sign-in).
3. **Delete doors + user row** — one atomic shard `batch`, the same
   all-or-nothing pairing create-account writes them with. Doors gone = the
   **cryptographic kill**: no wrapped DEK survives, so any stray ciphertext is
   permanently unreadable even if a copy escaped deletion.
4. **Revoke every session** (`sessions.deleteByUserId`).

The tombstone lands _before_ the shard delete so the retry path can always
recognize an in-progress deletion: tombstoned entry + missing user row =
resumed teardown (finish the remaining steps; there is no credential left for
the publicKey check to protect); missing user row _without_ a tombstone stays
what it always was — a server-side inconsistency to log and answer opaquely.

**What's deliberately kept:**

- **The username row (tombstoned).** The handle stays occupied forever so
  nobody can re-register it and be mistaken for the previous owner. This is
  the right _default_ because of the asymmetry: a release-after-cooldown
  policy can be added later, but a released name can never be re-occupied.
  ~70 bytes per deleted account, in the directory that outscales the shards
  ~20× anyway.
- **`purchases` rows.** Money-adjacent audit state — a provider id plus our
  random userId, no personal data. Late provider webhooks for a deleted
  account already log-and-drop in `applyPaddleEvent`.

**The deleting client** (`web-react` `hooks/use-delete-account.ts` +
bracemark-web's Account section): door fetch → `unlockAccount` (the wrong-password
check is the GCM tag, exactly as at sign-in) → sign → POST → `endSession()`,
which runs the full `clearData` wipe and drops the local session; AuthGuard
sends the user out to the marketing site's landing page (the same destination as
a deliberate sign-out — there is no signed-out page on `app.bracemark.com` worth
landing on; from an installed PWA it stays on `/sign-in` instead, see
[architecture.md](./architecture.md) — _apps_). Typed errors keep the form honest:
`InvalidCredentialsError` → "Incorrect password", `SubscriptionActiveError` →
a pointer at the Subscription section.

### deferred

- **Username release after a cooldown** — loosen the tombstone policy if
  reclaiming handles ever matters; the column (`deleted_at`) already carries
  the timestamp a policy would key on. Loosen-only: never re-tighten.
- **"Sign out everywhere"** — `sessions.deleteByUserId` already exists for the
  teardown; exposing it as a standalone Account action is a cheap, fully
  reversible security control (distinct from deletion, which is why it isn't
  bundled here).
- **Tombstone-teardown sweeper** — a crashed deletion whose session expired
  before a retry leaves a tombstoned name with shard rows still present (data
  already wiped; sign-in already refused). Harmless but untidy; sweep alongside
  the orphan-claim sweeper and `sessions.deleteExpired` when that lands.
