// The device-local expo-sqlite + drizzle database — the expo sibling of
// web-react's Dexie 'bracemark-data' store (data/db.ts there). Same tables, same
// invariants: that file is the canonical doc for what each table/column MEANS;
// this one documents where the SQLite port diverges. drizzle's useLiveQuery
// over these tables is the Dexie liveQuery analogue, which is why the
// connection opens with enableChangeListener (useLiveQuery subscribes to
// sqlite's change events).
//
// Kept SEPARATE from the session data (session-store.ts, expo-secure-store) —
// the same auth≠sync split as web's 'bracemark-session' vs 'bracemark-data' databases:
// auth/key material lives in credential storage, synced user data here.
//
// Greenfield schema policy: no migrations. The DDL below runs idempotently on
// open; when a table changes shape, edit it in place and recreate dev
// databases (delete the app / clear its data) rather than adding a migration
// step.
//
// How the web store's IndexedDB idioms map onto SQLite:
//
//  - `data` blobs. Dexie keeps every namespace's decrypted bytes in the
//    record. Here only the ENTITY namespaces (links/tags/lists/pins/
//    extractions/settings — small JSON) keep bytes in the row's `data` BLOB,
//    which preserves the projection invariant as-is: the `item_*` columns are
//    written in the same statement as the bytes they're derived from.
//    `files/` CONTENT lives in expo-file-system instead: BracemarkFileCrypto
//    (@stxapps/expo-crypto) decrypts ciphertext path-to-path in the native
//    layer, so file bytes never enter the JS heap, and e.g. expo-image renders
//    straight from the plaintext file:// path. The row only records presence
//    (`has_data_file` — web's "data absent = seen but not yet lazily
//    downloaded" marker, made explicit since a disk file can't be observed
//    inside a query). The plaintext file's location is DERIVED from `path` by
//    the future file store — never persist an absolute file:// URI: iOS moves
//    the app container between app updates, so stored URIs go stale.
//  - multiEntry indexes (`*itemTagIds`, `*itemFacetStatuses`). SQLite has no
//    multiEntry, so each becomes a junction table with an index on the value
//    column. Web's "no second table" rule was an IndexedDB workaround (a
//    projected column is only trustworthy there if the same `put` writes it);
//    SQLite has real multi-table transactions, so the invariant transposes to:
//    junction rows are written in the SAME transaction as their `items` row,
//    by the same single projector every payload write funnels through (the
//    port of web's toItemRecord).
//  - sparse indexes. IndexedDB omits keyless records from an index for free;
//    here partial indexes (`WHERE … IS NOT NULL`) do the same job — rows
//    without the field never enter the index, and the planner still uses them
//    for equality/range queries on the column.
//  - pendingOps' extra `username` index. Unneeded: the composite
//    (username, path) PRIMARY KEY already serves the drain's username scan as
//    a leftmost-prefix walk.
//
// The cross-table gate invariant (the syncMeta cursor must stay consistent
// with the items snapshot) holds for the same reason web keeps both stores in
// one Dexie database: one database, one transaction.

import { getTableColumns, type SQL, sql } from 'drizzle-orm';
import { drizzle, type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import {
  customType,
  integer,
  primaryKey,
  type SQLiteColumn,
  type SQLiteTable,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { openDatabaseSync } from 'expo-sqlite';

import type { LinksLayout, ThemeState } from '@stxapps/shared';

// Raw decrypted bytes. drizzle's built-in `blob({ mode: 'buffer' })` types as
// Node's Buffer, which doesn't exist on Hermes — expo-sqlite reads/binds BLOBs
// as Uint8Array, so type the column honestly.
const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'blob';
  },
});

// Per-account sync bookkeeping — see web-react db.ts `SyncMetaRecord` for the
// full semantics: `firstSyncDoneAt > 0` is the render gate, and the cursor is
// the compound `(updatedAt, path)` R2-`LastModified` timestamp, never the DO's
// internal seq.
export const syncMeta = sqliteTable('sync_meta', {
  // Scope key — one row per signed-in account on this device.
  username: text('username').primaryKey(),
  syncCursorUpdatedAt: integer('sync_cursor_updated_at').notNull(),
  syncCursorPath: text('sync_cursor_path').notNull(),
  firstSyncDoneAt: integer('first_sync_done_at').notNull(),
});

// Namespace discriminator for single-type ordered queries — same values as
// web-react db.ts `ItemType`.
export const ITEM_TYPES = ['link', 'list', 'tag', 'pin', 'extraction', 'setting', 'file'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

// One decrypted entity, keyed by its per-file path — the generic local store
// the sync engine writes into. Column meanings match web-react db.ts
// `ItemRecord` one-for-one; the `item_*` columns are the derived QUERY
// PROJECTION (source of truth is the payload) and are nullable because they're
// sparse. The two web fields that split here per the header: `data` holds
// bytes for entity namespaces only, and `has_data_file` marks a `files/`
// content row whose plaintext lives in expo-file-system.
export const items = sqliteTable('items', {
  path: text('path').primaryKey(),
  // The per-path R2 `LastModified` (epoch ms) — drives last-writer-wins; never
  // a local write time.
  updatedAt: integer('updated_at').notNull(),
  // Decrypted payload bytes — entity namespaces only (never `files/` content).
  data: bytes('data'),
  // `files/` content rows only: true once the decrypted blob has been
  // materialized on disk (location derived from `path`); null while the path
  // is known but not yet lazily downloaded.
  hasDataFile: integer('has_data_file', { mode: 'boolean' }),
  itemType: text('item_type', { enum: ITEM_TYPES }),
  // The USER-MEANINGFUL timestamps from inside the payload — the display sort
  // keys, distinct from the sync clock `updated_at` above.
  itemCreatedAt: integer('item_created_at'),
  itemUpdatedAt: integer('item_updated_at'),
  // Links only: the containing list's stable id.
  itemListId: text('item_list_id'),
  // Links only: stored (normalized) URL — exact lookup for readLinkByUrl.
  itemUrl: text('item_url'),
  // Links only: canonical dedup-identity key (canonicalUrlKey, client-only by
  // design — reprojectable when the key rules evolve).
  itemUrlKey: text('item_url_key'),
});

// `*itemTagIds` multiEntry analogue — one row per (link path, tag id), written
// in the same transaction as the `items` row (see header). The tag_id index
// answers membership ("links carrying tag X"); like web, the matched subset is
// ordered in a second step. That index carries `path` as its second column so
// the tag driver's `SELECT DISTINCT path WHERE tag_id IN (…)` (queries.ts
// readRest) reads as a COVERING scan — every column it wants is in the index, so
// it never touches the table. (The DISTINCT still builds a temp b-tree: a
// multi-value `IN` visits one tag's rows at a time and so can't dedupe by index
// order alone.)
export const itemTagIds = sqliteTable(
  'item_tag_ids',
  {
    path: text('path').notNull(),
    tagId: text('tag_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.path, t.tagId] })],
);

// `*itemFacetStatuses` multiEntry analogue — one `${status}:${facet}` token
// per recorded extraction facet outcome (pending = ABSENCE, so pending counts
// stay a set difference; see web-react db.ts). The token index makes the
// options-page facet tallies exact COUNT range-scans, no payload decode.
export const itemFacetStatuses = sqliteTable(
  'item_facet_statuses',
  {
    path: text('path').notNull(),
    token: text('token').notNull(),
  },
  (t) => [primaryKey({ columns: [t.path, t.token] })],
);

// The durable pending-ops queue — one local mutation not yet committed to the
// server; semantics (enqueue-after-local-write, remove-on-commit-result,
// `baseUpdatedAt` as the conflict base, why rows are username-scoped) are
// web-react db.ts `PendingOpRecord`'s, verbatim. The composite primary key is
// the one-row-per-(account, path) upsert AND the drain's username scan.
export const pendingOps = sqliteTable(
  'pending_ops',
  {
    username: text('username').notNull(),
    path: text('path').notNull(),
    op: text('op', { enum: ['put', 'delete'] }).notNull(),
    baseUpdatedAt: integer('base_updated_at').notNull(),
    // Which local WRITE this row stands for — see web-react db.ts `writeId` for the
    // full why. Short version: the composite key means a re-edit OVERWRITES the row,
    // so a drain that clears by path deletes whatever is there when its commit
    // returns — including an edit made during the push, whose bytes never went up.
    // The drain therefore compare-and-deletes on this (pending-store's
    // clearDrainedOps). NOT NULL where web's is optional: every enqueue mints one
    // (there is no non-tx enqueue here), and a column the type system forces makes a
    // future writer that forgets it a compile error rather than a silent regression
    // to delete-by-path.
    writeId: text('write_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.username, t.path] })],
);

// The fields of web-react db.ts `LocalSettingsRecord` minus its `id` — see
// there for why each source/value pair exists. Compile-time typing only: the
// stored JSON is untrusted (an older/newer build may have written it), so the
// read edge coerces and supplies defaults, the way web's use-settings +
// coerceThemeState already do.
export interface LocalSettingsValue {
  linksLayoutSource: 'sync' | 'local';
  linksLayout: LinksLayout;
  themeSource: 'sync' | 'local';
  theme: ThemeState;
  // Has the first-run "turn on link previews?" banner been dismissed on this
  // device? DEVICE-LOCAL on purpose while the setting it offers is synced: the
  // banner is a piece of onboarding chrome, and a second phone that has never
  // shown it should still get its one offer (docs/link-extraction.md — off by
  // default must cost one tap, not a settings expedition).
  previewsPromptDismissed: boolean;
}

// Device-local settings that DELIBERATELY never sync — the single-row settings
// bag behind the Settings "Device" tab. Stored as ONE JSON `value` column, not
// per-field columns, and this table is the only one shaped this way ON PURPOSE:
// Dexie's `localSettings: 'id'` indexes only the primary key, so on web every
// other field is a schemaless object property and a NEW device setting needs no
// schema bump — a JSON column is the sqlite construct with the same property
// (per-field columns would make expo stricter than web: DDL now, an ALTER TABLE
// migration once the schema freezes at launch). Nothing ever queries settings
// by field — the singleton row is read whole. The other tables keep real
// columns because their fields are keys/indexes (items' projection, the
// junctions, pendingOps' composite key) or protocol-pinned shapes (syncMeta's
// cursor, pendingOps' op kind, locks' verifier pair) — not an open-ended bag
// that grows a field per release.
export const localSettings = sqliteTable('local_settings', {
  // Single-row table — one settings bag per device, keyed by a constant.
  id: text('id', { enum: ['singleton'] }).primaryKey(),
  value: text('value', { mode: 'json' }).$type<LocalSettingsValue>().notNull(),
});

// The device-local last-known subscription copy (see web-react
// subscription-store.ts for the trust model — a soft per-device cache over
// `GET /v1/iap/status`, never the billing truth). On web this lives in
// localStorage, NOT Dexie — but only because the value is wanted SYNCHRONOUSLY
// at first render (react-query placeholderData) and IndexedDB is async-only.
// expo-sqlite has no such limitation (drizzle's expo driver is fully sync), so
// the cache's principled home is here with its sibling stores: one database,
// one wipe in clear-data. Stored as an untyped JSON `value` (deliberately no
// `$type`): the read edge safeParses it through subscriptionStatusSchema, so a
// stale/corrupt shape degrades to null, never a malformed plan string.
export const subscriptionStatus = sqliteTable('subscription_status', {
  // Single-row table — one cached status per device, keyed by a constant.
  id: text('id', { enum: ['singleton'] }).primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

// Device-local app/list locks. IMPORTANT: locks gate UI locally (they are never
// synced — different devices can lock different lists), and a lock guards
// already-decrypted data sitting on the device, so what's stored is a one-way
// password VERIFIER (@stxapps/expo-crypto lock-verifier), never the password or
// a reversible copy. Whether a lock is currently UNLOCKED is in-memory React
// state only (the future lock-provider), so every lock re-engages on relaunch —
// nothing here tracks it.
export const locks = sqliteTable('locks', {
  // `APP_LOCK_ID` for the app lock, else the locked list's id (stable across
  // renames). One row per lock.
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['app', 'list'] }).notNull(),
  // The verifier pair (hex — see LockVerifier in @stxapps/expo-crypto).
  salt: text('salt').notNull(),
  hash: text('hash').notNull(),
  // List locks only: while locked, also hide the list (and its subtree) from the
  // sidebar and the list pickers — not just gate its links.
  hideList: integer('hide_list', { mode: 'boolean' }),
  // Opt-in to unlock this lock with device biometry (Face ID / Touch ID). An
  // expo-only flag (native has biometry, web doesn't); a pure boolean gate over
  // the same in-memory unlock — no secret is stored behind it (docs/locks.md).
  biometric: integer('biometric', { mode: 'boolean' }),
});

// The device-local, per-HOST favicon cache — web-react db.ts `FaviconRecord`
// is the canonical doc (why per-host not per-link, why a recorded `none`
// verdict, why it's never synced yet still wiped on sign-out — the SET of
// hosts is the user's browsing shape). Unlike web, the row holds NO bytes: an
// `ok` verdict's icon lives as a plaintext file on disk (favicon-store.ts —
// the `files/` content pattern), so the render path is a derived `file://`
// uri and the per-mount reads the scrolling rows pay stay off the BLOB.
export const favicons = sqliteTable('favicons', {
  // The display host (`hostFromText`), e.g. `github.com` — never a full URL.
  host: text('host').primaryKey(),
  status: text('status', { enum: ['ok', 'none'] }).notNull(),
  // When this row was last resolved — the age the `none` retry is measured from.
  fetchedAt: integer('fetched_at').notNull(),
});

// Device-local links-drawer VIEW state — which nav sections/rows are currently
// collapsed. Kept OUT of `local_settings` ON PURPOSE, mirroring web: bracemark-web's
// sidebar keeps this in localStorage, deliberately separate from its device
// SETTINGS store (see that sidebar's header) — collapse is low-value,
// page-scoped view state, not a cross-cutting device setting that surfaces in
// the Settings "Device" tab. On web the migration-cost argument drives it; here
// the JSON `value` column already makes new fields migration-free, so the reason
// is purely the separation of concerns — hence its OWN single-row table, the
// same shape choice as `subscription_status` (a distinct device-local cache in
// its own bag, not crammed into settings). Never synced (each device collapses
// independently), wiped on sign-out with the rest (clear-data) so the next
// account doesn't inherit this one's list/tag ids.
export interface SidebarViewValue {
  // Collapse ids — list/tag ids plus the two reserved section ids
  // (`section:lists` / `section:tags`). Present in the array == collapsed.
  collapsedIds: string[];
}
export const sidebarView = sqliteTable('sidebar_view', {
  // Single-row table — one view bag per device, keyed by a constant.
  id: text('id', { enum: ['singleton'] }).primaryKey(),
  value: text('value', { mode: 'json' }).$type<SidebarViewValue>().notNull(),
});

// Device-local bookkeeping for the app-store review prompt (bracemark-expo
// `lib/review-prompt.ts` owns the rules): how many links this device has saved
// since the last ask, when that ask was, how many asks there have been, and
// whether the user went to the store page themselves. Its own single-row bag for the
// same reason `sidebar_view` is — it is not a setting, nothing surfaces it in
// the Settings "Device" tab, and web has no counterpart (a browser has no store
// sheet to raise). Never synced: the OS caps the prompt per install, so a count
// from another device would only spend this one's budget early. Wiped on
// sign-out with the rest (clear-data), not by delete-all-data — so every field
// below reads "since the last sign-in on this device", never "ever".
export interface ReviewPromptValue {
  savesSinceAsk: number;
  // Epoch ms of the last `requestReview` call, or null if there has been none.
  // When we ASKED, not when a sheet showed — the OS never says whether it did.
  lastAskedAt: number | null;
  // `requestReview` calls made — what the cap on asks (MAX_ASKS) counts.
  askCount: number;
  // Did the user open the store's review page from Settings → About? The one
  // signal we can get that they rated, since neither store reports it.
  openedStorePage: boolean;
}
export const reviewPrompt = sqliteTable('review_prompt', {
  // Single-row table — one bag per device, keyed by a constant.
  id: text('id', { enum: ['singleton'] }).primaryKey(),
  value: text('value', { mode: 'json' }).$type<ReviewPromptValue>().notNull(),
});

const schema = {
  syncMeta,
  items,
  itemTagIds,
  itemFacetStatuses,
  pendingOps,
  localSettings,
  subscriptionStatus,
  locks,
  favicons,
  sidebarView,
  reviewPrompt,
};

// The exclusive upper bound of a namespace prefix scan — the sqlite spelling
// of Dexie's `where('path').startsWith(prefix)`, as the half-open primary-key
// range `[prefix, prefixEnd(prefix))`. Every prefix ends in '/' (0x2F), so the
// bound is 'links/' → 'links0'.
//
// NOT `prefix + '\uFFFF'` (the idiom web can use): sqlite's BINARY collation
// compares UTF-8 BYTES, and any astral character encodes to F0..F4 — above
// U+FFFF's EF BF BF — so a path carrying one would sort outside that range.
// Dexie's UTF-16 code-unit order has no such hole (surrogates sort below
// U+FFFF), which is why the same trick is safe there and quietly wrong here.
// Today's paths are ASCII, so this is a latent divergence, not a live bug —
// the successor bound closes it for any suffix at all.
// The scan that APPLIES this bound is item-store.ts's `namespaceRows`, with the
// other raw-row reads; what lives here is the key encoding itself, next to the
// DDL that declares the primary key it describes.
export function prefixEnd(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

// The SET clause of a MULTI-ROW upsert: every non-key column takes the
// incoming row's value (`excluded.<column>`), which is the full-replace
// semantics of Dexie's `put` that a single-row `set: row` gave. A multi-row
// statement can't name one row's values, so this is how the bulk writers
// (item-store's putItemsTx, pending-store's enqueueTx) keep that semantics
// while sending one statement per batch rather than one per row — drizzle's
// per-statement cost was most of a restore's JS-thread time
// (docs/data-lifecycle.md, _readings — expo_). Derived from the table's own
// columns, so a column added to the schema joins the upsert with no edit here.
export function upsertExcludedSet<T extends SQLiteTable>(
  table: T,
  keyColumns: readonly SQLiteColumn[],
): Record<string, SQL> {
  const keys = new Set(keyColumns.map((column) => column.name));
  const set: Record<string, SQL> = {};
  for (const [field, column] of Object.entries(getTableColumns(table))) {
    if (!keys.has(column.name)) set[field] = sql.raw(`excluded.${column.name}`);
  }
  return set;
}

// How many rows fit one multi-row statement for a table this wide, keeping its
// bound variables under the same budget the stores' `IN (...)` batches keep
// (`MAX_BOUND_PARAMS`), far below sqlite's ceiling.
export const MAX_BOUND_PARAMS = 500;
export function rowsPerStatement(table: SQLiteTable): number {
  return valuesPerStatement(Object.keys(getTableColumns(table)).length);
}

// The same budget for rows `width` values wide, for a `valuesList` below.
export function valuesPerStatement(width: number): number {
  return Math.max(1, Math.floor(MAX_BOUND_PARAMS / width));
}

// A `VALUES (…), (…)` list of bound rows, for the set-at-a-time statements that
// match a batch of keys against a table in one statement (item-store's
// stampItemUpdatedAts joins it, pending-store's clearDrainedOps IN-tests it). A
// statement per row made drizzle build and prepare each one in JS, which the
// write edge already measured as most of its cost (docs/data-lifecycle.md,
// _readings — expo_). SQLite names the columns `column1`, `column2`, ….
export function valuesList(rows: readonly (readonly unknown[])[]): SQL {
  return sql`VALUES ${sql.join(
    rows.map(
      (row) =>
        sql`(${sql.join(
          row.map((value) => sql`${value}`),
          sql`, `,
        )})`,
    ),
    sql`, `,
  )}`;
}

// Exported for the read edge's change subscription (hooks/use-live-read.ts):
// expo-sqlite's addDatabaseChangeListener reports changes across every open
// database, so subscribers filter events to this one by name.
export const DB_NAME = 'bracemark-data.db';

// Idempotent DDL, run on every open (the greenfield no-migrations policy —
// header). Index set mirrors web-react db.ts's Dexie stores line: the four
// compound indexes are the two orderings (date modified / date added) over the
// two groupings (per type / per list); url and url-key are the exact-lookup
// indexes. All the sparse ones are partial so non-carrying rows (e.g. `files/`
// content) stay out.
//
// EVERY COMPOUND INDEX ENDS IN `path`, and that is not decoration. A Dexie
// compound index orders equal-key records by the primary key INHERENTLY — the
// tiebreak is a property of the index, not of the query. A sqlite index has no
// such implicit trailing column, so the ported reads have to spell the tiebreak
// out (`ORDER BY <sort column>, path` — queries.ts rangeFastPath/scanChunk/
// scanUnsettledLinks), and an index stopping at the sort column can't serve it:
// the planner falls back to `USE TEMP B-TREE FOR LAST TERM OF ORDER BY` and
// block-sorts every group of rows sharing a timestamp. That group is normally
// one row and the sort is free — but a bulk import stamps thousands of links the
// same millisecond (queries.ts `LinkScanCursor` names this), and there the sort
// is the whole group, per page, on the JS thread, behind a live query that
// re-runs on every `items` change. Measured at 30k links with a 15k-row import
// group: 5.3ms -> 0.07ms for one page, 224ms -> 39ms to keyset-walk the group.
// One ASC index serves both sort directions because the ORDER BY is uniform (the
// sort column and `path` always move together).
//
// Mind the `IF NOT EXISTS` when EDITING an index here: on a database that has
// already been opened, a changed column list is a SILENT NO-OP (same name, old
// columns, no error). Recreate the dev database — delete the app / clear its
// data — as the greenfield policy in the header says, or the change won't take.
//
// There is deliberately NO index on `updated_at`. It reads like it should have
// one (it is the sync clock), but nothing drives on it: the engine's reconcile
// reads every row unconditionally (item-store.ts listItemUpdatedAts — a plain
// table SCAN, which is the right plan for a whole-table projection) and the only
// other reader compares it as a residual inside a primary-key point update
// (markItemDataFileIfCurrent). An index would be pure write cost on the busiest
// table in the app — every pulled record, every local edit, every imported row.
//
// Exported for the store specs, which run it against an in-memory sqlite
// (item-store.spec.ts) so the guarded writes are tested over the REAL schema —
// never imported by runtime code outside this module.
export const DDL = `
  CREATE TABLE IF NOT EXISTS sync_meta (
    username TEXT PRIMARY KEY NOT NULL,
    sync_cursor_updated_at INTEGER NOT NULL,
    sync_cursor_path TEXT NOT NULL,
    first_sync_done_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    path TEXT PRIMARY KEY NOT NULL,
    updated_at INTEGER NOT NULL,
    data BLOB,
    has_data_file INTEGER,
    item_type TEXT,
    item_created_at INTEGER,
    item_updated_at INTEGER,
    item_list_id TEXT,
    item_url TEXT,
    item_url_key TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_items_type_item_updated_at
    ON items(item_type, item_updated_at, path) WHERE item_type IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_items_type_item_created_at
    ON items(item_type, item_created_at, path) WHERE item_type IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_items_list_item_updated_at
    ON items(item_list_id, item_updated_at, path) WHERE item_list_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_items_list_item_created_at
    ON items(item_list_id, item_created_at, path) WHERE item_list_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_items_url
    ON items(item_url) WHERE item_url IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_items_url_key
    ON items(item_url_key) WHERE item_url_key IS NOT NULL;
  CREATE TABLE IF NOT EXISTS item_tag_ids (
    path TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (path, tag_id)
  );
  CREATE INDEX IF NOT EXISTS idx_item_tag_ids_tag_id
    ON item_tag_ids(tag_id, path);
  CREATE TABLE IF NOT EXISTS item_facet_statuses (
    path TEXT NOT NULL,
    token TEXT NOT NULL,
    PRIMARY KEY (path, token)
  );
  CREATE INDEX IF NOT EXISTS idx_item_facet_statuses_token
    ON item_facet_statuses(token);
  CREATE TABLE IF NOT EXISTS pending_ops (
    username TEXT NOT NULL,
    path TEXT NOT NULL,
    op TEXT NOT NULL,
    base_updated_at INTEGER NOT NULL,
    write_id TEXT NOT NULL,
    PRIMARY KEY (username, path)
  );
  CREATE TABLE IF NOT EXISTS local_settings (
    id TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscription_status (
    id TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS locks (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    hide_list INTEGER,
    biometric INTEGER
  );
  CREATE TABLE IF NOT EXISTS favicons (
    host TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sidebar_view (
    id TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS review_prompt (
    id TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
`;

// A transaction handle over this database — what the tx-taking store helpers
// (item-store's putItemsTx, pending-store's enqueuePutTx) accept, so a
// multi-store write (data/mutations.ts) can compose both into ONE transaction:
// the local-put + pending-op atomicity web gets from Dexie's multi-table
// `db.transaction('rw', items, pendingOps, …)`.
export type DbTx = Parameters<Parameters<ExpoSQLiteDatabase<typeof schema>['transaction']>[0]>[0];

// Opened lazily on first use (not at module load) so merely importing the
// package barrel never touches the native sqlite module — jest and tooling can
// import sibling modules without a mock for this one.
let db: ExpoSQLiteDatabase<typeof schema> | null = null;

export function getDb(): ExpoSQLiteDatabase<typeof schema> {
  if (!db) {
    const sqlite = openDatabaseSync(DB_NAME, { enableChangeListener: true });
    // WAL lets the change-listener reads proceed while a write is in flight.
    sqlite.execSync('PRAGMA journal_mode = WAL;');
    sqlite.execSync(DDL);
    db = drizzle(sqlite, { schema });
  }
  return db;
}
