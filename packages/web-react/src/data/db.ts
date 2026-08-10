'use client';

// Client-only local store — the source of truth the UI reads from (see
// docs/local-first-sync.md "layer 1"). Dexie over IndexedDB, with `liveQuery`
// for reactive reads, is the doc's preferred default. Holds DECRYPTED data: the
// sync engine decrypts blobs with @stxapps/web-crypto before they land here, and
// the network layer never sees plaintext.
//
// Kept in a SEPARATE database ('bracemark-data') from the raw-IDB session store
// ('bracemark-session' in session-store.ts). The session DB holds auth/key material and
// is hand-rolled; Dexie wants to own its own schema/versioning, so the two don't
// share a database. Mirrors the auth≠sync split: auth state lives in one place,
// synced user data in another.
//
// Within THIS database, `syncMeta` and `items` share one Dexie instance on
// purpose: the gate invariant ties the cursor (syncMeta) to the items snapshot,
// so they must stay consistent — one database keeps a cross-store atomic
// transaction possible (IndexedDB transactions can't span databases).

import Dexie, { type EntityTable, type Table } from 'dexie';

import type { OpKind, ThemeState } from '@stxapps/shared';

// Per-account sync bookkeeping. The presence of a row with `firstSyncDoneAt > 0`
// is the gate that lets the app render local data instead of blocking on a full
// pull, and it's the ONLY way to tell "synced, zero items" apart from "never
// synced" — without it, an empty local store is ambiguous.
//
// The cursor is a TIMESTAMP, not a seq. Per docs/local-first-sync.md the wire
// cursor is the compound key `(updatedAt, path)` — R2's `LastModified` (epoch ms)
// plus a path tiebreak — never the op log's `seq`. `seq` stays internal to the DO:
// it can't be reconstructed from an R2 listing, so a DO rebuild or fallback would
// have no seq to resume from, whereas the newest `LastModified` in a listing
// always IS the cursor. The two halves map directly to the `ops/list` query
// params `since` + `sincePath` (see @stxapps/shared sync/endpoints.ts).
export interface SyncMetaRecord {
  // Scope key — one row per signed-in account on this device.
  username: string;
  // High-water mark: the newest R2 `LastModified` (epoch ms) reconciled into the
  // local store. The incremental pull asks the server for ops AFTER this; 0 until
  // the first sync completes.
  syncCursorUpdatedAt: number;
  // Path tiebreak for the compound `(updatedAt, path)` cursor — the path of the
  // last op consumed at `syncCursorUpdatedAt`. Several files can share a
  // millisecond, so without it a single ms holding more ops than one page could
  // never be paged past. Empty only for a seeded new account (nothing pulled
  // yet); the server treats a missing `sincePath` as the low sentinel (so the
  // next pull includes every op at that ms).
  syncCursorPath: string;
  // Epoch ms the first full sync COMPLETED, or 0 while it hasn't. The invariant:
  // > 0 means "the local store is a complete, consistent snapshot up to the
  // cursor."
  firstSyncDoneAt: number;
}

// One decrypted entity, keyed by its per-file path — the generic local store the
// sync engine writes into (one entity per file, per docs/local-first-sync.md
// "data model"). Every namespace flows through here identically: `links/{id}.enc`
// (the always-resident link index), `tags/{id}.enc`, `lists/{id}.enc`,
// `pins/{id}.enc`, `extractions/{id}.enc` (per-link extraction bookkeeping —
// docs/link-extraction.md), `settings/<concern>.enc`, and lazily-fetched
// `files/{id}.enc` content.
//
// "Item" (not "entity" — that reads like a server-side D1 row — and not "file"
// — that's the `files/` namespace specifically) is the established name for this
// one-table-of-every-type store in E2E sync systems (Standard Notes, Joplin).
//
// - `path` is the FULL relative path (`links/l_abc.enc`) AND the primary key — the
//   same key the op log, pending queue, and R2 use, so reconcile can compare a
//   server op to a local record directly (there is no separate id; the path IS
//   the id). Named `path`, not `id`, to match every other layer and to avoid
//   colliding with the entities' own logical `id` field (lists/tags carry one
//   inside the blob — see entities.ts).
// - `updatedAt` is the per-path R2 `LastModified` (epoch ms) the server stamped;
//   it drives last-writer-wins and is the value compared in both incremental
//   apply and the fallback listing — never Dexie's local write time.
// - `data` is the decrypted blob bytes (the sync engine decrypts with
//   @stxapps/web-crypto before it lands here; plaintext never crosses the
//   network). Absent for a `files/` content record that's been seen but not yet
//   lazily downloaded — only its `updatedAt` is known.
//
// The `item*` columns are the QUERY PROJECTION: the few list-view fields lifted
// out of the decrypted `data` blob so IndexedDB can index them. Without them a
// view like "newest 30 links in this list" would have to read+JSON.parse every
// `links/` blob into memory and sort there — O(library) on every reactive tick. A
// compound index over these columns turns it into a keyset walk that materializes
// only the page shown. They're DERIVED, not authoritative: `data` is the source
// of truth, and every column here is computed FROM it by the single projector
// (data/projection.ts `toItemRecord`) that every write site must funnel through —
// so the index can never drift from the bytes it indexes (no second table, no
// cross-table transaction; the column is written in the same `put` as `data`).
// All are sparse: a record gets a key only where the field applies (a `files/`
// content record has none; only `links/` links carry `itemListId`/`itemTagIds`),
// and IndexedDB simply omits keyless records from that index — exactly the
// per-type filtering we want.
export type ItemType = 'link' | 'list' | 'tag' | 'pin' | 'extraction' | 'setting' | 'file';

export interface ItemRecord {
  path: string;
  updatedAt: number;
  data?: Uint8Array;
  // Namespace of `id`'s prefix — the discriminator a single-type ordered query
  // ranges on (`[itemType+itemUpdatedAt]`); a path prefix can't feed a compound
  // index, so it's stored as its own column.
  itemType?: ItemType;
  // The USER-MEANINGFUL timestamps from inside the blob (entities.ts) — distinct
  // from the R2-`LastModified` `updatedAt` above that drives sync. These are the
  // display sort keys.
  itemCreatedAt?: number;
  itemUpdatedAt?: number;
  // Links only: the ids the link references — `link.listId` and `link.tagIds` (the
  // `{id}` of `lists/{id}.enc` / `tags/{id}.enc`, or a system-list constant).
  // Indexed so a list view filters+orders in one index range, and a tag view
  // finds membership via the multiEntry index. Ids, never names: a list/tag can
  // be renamed, but its id is stable, and that's what a link stores.
  itemListId?: string;
  itemTagIds?: string[];
  // Links only: the link's stored (normalized) URL — indexed so `readLinkByUrl`
  // is an exact index lookup instead of a full `links/` scan + decode-every-blob.
  // Callers normalize the query URL the same way the editor normalized this one
  // before storing.
  itemUrl?: string;
  // Links only: the link's canonical DEDUP IDENTITY key — `canonicalUrlKey(url)`
  // (@stxapps/shared), the aggressive fold (scheme/www/port/trailing-slash/query
  // order/fragment) behind the "is this URL already saved?" checks
  // (readLinkByUrlKey: extension popup, web quick-add). DERIVED and CLIENT-ONLY
  // by design: it lives in this projection, never in the synced blob, so when
  // the key rules evolve (e.g. utm stripping) a schema bump + reprojection
  // re-keys every link — nothing is frozen into LWW state. Sparse: absent when
  // the stored url is confirm-saved raw text the key can't be derived from
  // (canonicalUrlKey → null; exact `itemUrl` covers those).
  itemUrlKey?: string;
  // Extractions only: one `${status}:${facet}` token per facet (projection.ts) —
  // e.g. `["done:titleImage", "failed:readMode"]`. Backs the `*itemFacetStatuses`
  // multiEntry index so the options page tallies facet status with
  // `equals('done:titleImage')`-style range-counts (one index entry per facet, so the
  // count is the exact per-link total) without decoding a blob. Statuses are
  // done/failed/permanent only — pending = ABSENCE (no token), so the pending count is
  // a set difference (link total minus recorded outcomes), see readExtractionFacetCounts.
  itemFacetStatuses?: string[];
}

// One local mutation not yet committed to the server — the durable pending-ops
// queue (docs "layer 1" + "the three flows: push"). Enqueued by the UI right
// after it writes the local store, drained by the sync engine, and removed only
// once the path comes back in a commit's `results` — which is what makes offline
// writes durable and gives crash recovery for free (a process that dies between
// the R2 PUT and the commit finds the entry still here on restart).
//
// One row per (account, path): re-editing a path before the queue drains
// overwrites the prior entry (local last-writer-wins), so the queue never holds
// two ops for the same file.
export interface PendingOpRecord {
  // Whose queue. NOT live multi-account support: sign-out wipes ALL tables
  // (clearData in clear-data.ts — decrypted data doesn't outlive the session), and
  // `items` isn't account-scoped at all, so only one account's data is ever
  // resident. The scoping is (a) schema future-proofing — adding a key column
  // later means a copy-everything IDB migration on users' devices — and (b)
  // race-safety: a stale sync run for a prior account can't drain its queue into
  // the next account's session.
  username: string;
  // The targeted entity's full relative path (matches an ItemRecord `id`).
  path: string;
  // `put` (created/edited) or `delete`. A re-edit can flip put→delete in place.
  op: OpKind;
  // The path's stored server `updatedAt` at edit time — the BASE the edit started
  // from. Reconcile compares the pulled server `updatedAt` to this to tell a clean
  // fast-forward (server == base, often our own echo) from a true conflict
  // (server > base: both sides moved since the base). 0 for a fresh create.
  baseUpdatedAt: number;
  // Which local WRITE this row stands for — minted per enqueue (pending-store.ts), so
  // a re-edit that overwrites the row for this (account, path) is a DIFFERENT op, not
  // the same one re-timed. It exists for exactly one reader: the drain clears the ops
  // it pushed by compare-and-delete on this value (clearDrainedOps), never blindly by
  // path. Without it a cycle that read its snapshot, then uploaded, deletes whatever
  // row is at that path when it commits — including an edit made DURING the push,
  // which it never uploaded. The local store then holds a change with nothing queued
  // to carry it, and it never syncs: no error, no pending count, no retry. Settings is
  // where that bites, because every click rewrites the SAME path (and kicks a sync),
  // so a burst of them lands inside each other's push windows; entity namespaces mint
  // a fresh path per record and rarely collide. NOT indexed — only ever read back
  // through the row's own primary key. REQUIRED, though Dexie stores rows
  // unvalidated: it is the type system, not the store, that has to stop a future
  // writer from enqueueing an untagged row (there are three enqueue sites, and one
  // of them — the bulk importer — was already restating the row shape by hand).
  //
  // `baseUpdatedAt` cannot stand in for it: a re-edit mid-cycle reads the same base
  // (the commit's restamp hasn't landed yet), so the two ops are identical in every
  // other field.
  writeId: string;
}

// Device-local settings that DELIBERATELY never sync — the off-sync counterpart
// to the synced `settings/general.enc` file. Unlike everything in `items`, these
// rows have no path, no op-log entry, and no R2 object: the sync engine never
// touches this table, and `clearData` (clear-data.ts) wipes it on sign-out so
// a second user on the device can't inherit the first's preferences.
//
// A single row (constant `id`) holds the Settings "Device" tab choices. Each
// setting follows the same source/value pair — a device-local `*Source` toggle
// selecting between the synced value and this row's own device value:
//   - `linksLayoutSource` — which source the links page actually renders, `'sync'`
//     (the synced `settings/general.enc` value) or `'local'` (this row's own
//     `linksLayout`). It's device-local on purpose: "use this device's own layout"
//     is a per-device decision that must NOT propagate to other devices. (The Misc
//     UI labels the `'local'` choice "Device".)
//   - `linksLayout` — this device's own layout, applied only while
//     `linksLayoutSource` is `'local'`.
//   - `themeSource` / `theme` — the same pair for the theme: `themeSource` picks the
//     synced `settings/general.enc` theme vs this row's own `theme`, applied only
//     while `themeSource` is `'local'`. Theme is a natural per-device choice (dark
//     laptop, light phone), so the Device option matters more here than for layout.
//     The provider mirrors the RESOLVED theme to localStorage for the pre-paint FOUC
//     script (theme-provider.tsx) — the encrypted synced value can't be read before
//     paint, so localStorage stays the synchronous cache regardless of source.
export interface LocalSettingsRecord {
  // Single-row table — one settings blob per device, keyed by a constant.
  id: 'singleton';
  linksLayoutSource: 'sync' | 'local';
  // A `string`, not `LinksLayout`, for the same reason the synced one is (see
  // `settingsGeneralSchema` in entities.ts / the `Settings` shape in use-settings.ts):
  // this is a PERSISTED value that Dexie hands back unvalidated, so a row written by a
  // build whose `LINKS_LAYOUTS` had more entries than this one's still reads back
  // as-is. Writers stay strict — `setLocalLinksLayout` takes a `LinksLayout`.
  linksLayout: string;
  themeSource: 'sync' | 'local';
  theme: ThemeState;
  // Has the first-run "your links have no previews" banner been dismissed on this
  // device? DEVICE-LOCAL on purpose while the thing it points at (the synced
  // `serverExtraction` opt-in, or a browser-extension install) is not: the banner is
  // onboarding chrome, and a second browser that has never shown it should still get
  // its one offer (docs/link-extraction.md — _the links-page offer_). Absent on rows
  // written before the field existed; every read defaults it to `false`.
  previewsPromptDismissed: boolean;
}

// One device-local lock — the app lock or a per-list lock. Like `localSettings`,
// these rows DELIBERATELY never sync (no path, no op-log entry, no R2 object) and
// are wiped on sign-out by `clearData`, which is what makes "forgot a lock
// password → sign out, sign back in with the account password" the recovery path.
//
// A lock is a UI gate over already-decrypted local data (a shoulder-surfing
// deterrent, not encryption — everything in `items` is plaintext to anyone with
// the device), so what's stored is a one-way password VERIFIER
// (@stxapps/web-crypto lock-verifier), never the password or a reversible copy.
// Whether a lock is currently UNLOCKED is in-memory React state only
// (lock-provider), so every lock re-engages on reload — nothing here tracks it.
export interface LockRecord {
  // `APP_LOCK_ID` for the app lock, else the locked list's id (stable across
  // renames). One row per lock.
  id: string;
  kind: 'app' | 'list';
  // The verifier pair (hex) — see LockVerifier in @stxapps/web-crypto.
  salt: string;
  hash: string;
  // List locks only: while locked, also hide the list (and its subtree) from the
  // sidebar and the list pickers — not just gate its links.
  hideList?: boolean;
}

// One site's favicon, keyed by DISPLAY HOST (`hostFromUrl` — www-stripped, so it
// matches the string the layouts render beside it). Per HOST, not per link: a
// 5k-link library resolves to a few hundred distinct hosts, so this table holds
// hundreds of ~1-2KB icons, not thousands of blobs.
//
// This is a CACHE of public, re-fetchable bytes, which is why it's device-local
// (like `localSettings` and `locks`) and NOT an extraction facet: a favicon is
// nobody's user data, so it earns no `files/{id}.enc` blob, no encryption, no op-log
// entry, and no quota charge. A fresh device just re-fetches. Storing it per-link in
// `extractions/` would mint one synced blob per link to represent one icon per site —
// see docs/link-extraction.md.
//
// Still wiped on sign-out (clear-data.ts) and by delete-all-data: the SET of hosts
// is user data even though each icon isn't, so a second user on this device must not
// read the first's browsing shape out of it.
export interface FaviconRecord {
  // The display host (`hostFromUrl`), e.g. `github.com` — never a full URL.
  host: string;
  // `ok` — `bytes` holds the icon. `none` — this host has no reachable favicon
  // (404, non-image, the extractor declined). A negative is RECORDED rather than
  // just skipped so a reload doesn't re-buy a fetch for every iconless host; it
  // ages out via FAVICON_RETRY_MS (favicon-store.ts) so a site that later adds one
  // is picked up.
  status: 'ok' | 'none';
  // Raw icon bytes, present iff `status === 'ok'` — and always an icon the render
  // path can decode, since the fetch gates on `isRenderableIconBytes` before
  // writing (favicon-provider.tsx). No content-type is stored: useFaviconUrl
  // re-sniffs it off these bytes when it mints the Blob (see its header for why a
  // mime is needed there at all, and why deriving beats storing).
  bytes?: Uint8Array;
  // When this row was last resolved — the age the `none` retry is measured from.
  fetchedAt: number;
}

class BracemarkDb extends Dexie {
  syncMeta!: EntityTable<SyncMetaRecord, 'username'>;
  items!: EntityTable<ItemRecord, 'path'>;
  pendingOps!: Table<PendingOpRecord, [string, string]>;
  localSettings!: EntityTable<LocalSettingsRecord, 'id'>;
  locks!: EntityTable<LockRecord, 'id'>;
  favicons!: EntityTable<FaviconRecord, 'host'>;

  constructor() {
    super('bracemark-data');
    this.version(1).stores({
      // `username` primary key — one bookkeeping row per account.
      syncMeta: 'username',
      // `path` primary key + `updatedAt` index (the engine's R2-clock reconcile
      // scan). The rest serve the read layer's link views, all sparse (only
      // records with the keyed field appear). The two ordering fields
      // (itemUpdatedAt = date modified, itemCreatedAt = date added) each pair with
      // the same two compound indexes, so a view can sort either way:
      //   [itemType+item{Updated,Created}At]   — one type, ordered (the "all links"
      //                                          view): range the type, reverse.
      //   [itemListId+item{Updated,Created}At] — one list, ordered: range the list id.
      //   *itemTagIds (multiEntry)             — links carrying a given tag id
      //                                          (membership; multiEntry can't
      //                                          compound, so the tag view sorts its
      //                                          matched subset in JS).
      //   itemUrl                              — exact link lookup by stored URL
      //                                          (readLinkByUrl), links only.
      //   itemUrlKey                           — canonical dedup-identity lookup
      //                                          (readLinkByUrlKey), links only.
      //   *itemFacetStatuses (multiEntry)      — `${status}:${facet}` per facet;
      //                                          extraction facet counts + work-loop
      //                                          lookups, extractions only.
      items:
        'path, updatedAt, [itemType+itemUpdatedAt], [itemType+itemCreatedAt], ' +
        '[itemListId+itemUpdatedAt], [itemListId+itemCreatedAt], *itemTagIds, itemUrl, ' +
        'itemUrlKey, *itemFacetStatuses',
      // pending-ops queue. Compound `[username+path]` primary key gives
      // the one-row-per-(account,path) upsert above; the `username` index scopes a
      // drain to the active account. Unlisted stores (syncMeta, items) carry forward.
      pendingOps: '[username+path], username',
      // Device-local settings — a single row keyed by the constant `id`. No sync
      // bookkeeping, so just the primary key.
      localSettings: 'id',
      // Device-local locks — one row per lock, keyed by APP_LOCK_ID / list id.
      locks: 'id',
      // Device-local favicon cache — one row per display host. Primary key only:
      // every read is an exact `get(host)` from a rendered row, never a scan.
      favicons: 'host',
    });
  }
}

// Single app-lifetime instance. Dexie opens lazily on first operation, so merely
// importing this on the server (where there's no IndexedDB) is inert — only the
// awaited reads/writes below touch IDB, and those run in client effects.
export const db = new BracemarkDb();
