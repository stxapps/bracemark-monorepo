// The typed read layer over the `items` table — the expo sibling of
// web-react's data/queries.ts (that file is the canonical doc for what each
// read MEANS: the query grammar's evaluation order, the pinned overlay, the
// driver choices, why `total` goes undefined under text search). This one
// documents where the SQLite port diverges:
//
//  - Queries are drizzle over the db.ts indexes instead of Dexie index walks.
//    The compound-index fast paths become `WHERE … ORDER BY <sort column>,
//    path` (the explicit `path` tiebreak reproduces Dexie's primary-key order
//    for equal timestamps); the sparse-index "rows without the column never
//    appear" property becomes an explicit `IS NOT NULL` on the sort column.
//  - The multiEntry tag index is the `item_tag_ids` junction (db.ts): the tag
//    driver selects candidate paths from it, and the tag predicates read a
//    junction-built path → tagIds map instead of a `record.itemTagIds` array.
//  - Dexie's lazy filtered cursor walk becomes a keyset-paginated chunk loop
//    (resume strictly after `(sortValue, path)`), so a page read still touches
//    a bounded slice instead of materializing the library.
//  - No zone-echo constraint: reactivity here comes from expo-sqlite's change
//    listener (hooks/use-live-read.ts), not from tracking which ranges a
//    querier touched — helpers can await freely.
//
// Ported so far: the namespace reads (lists/tags/pins/settings), the link
// library query (`readLinks`), the by-id lookups (`readLinkById`,
// `readExtraction` — the write edge's re-read-before-merge and destroy's
// satellite sweep), and the by-url lookups + quota count behind the add editor
// (`readLinkByUrl`/`readLinkByUrlKey`, `countLinks`), and the extraction
// tallies + pending-drain pages behind on-device extraction — the one section
// that deliberately IMPROVES on web's shape instead of mirroring it (SQLite can
// express the pending anti-join Dexie can't; see that section's header).

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  notInArray,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { z } from 'zod';

import type {
  Clause,
  Extraction,
  ExtractionItem,
  LinkItem,
  LinkQuery,
  LinkSortOn,
  ListItem,
  PinItem,
  SettingsGeneral,
  TagItem,
  WithPath,
} from '@stxapps/shared';
import {
  canonicalUrlKey,
  compareRank,
  dropCachedExtraction,
  dropCachedLink,
  EXTRACTIONS_PREFIX,
  extractionSchema,
  FILES_PREFIX,
  getCachedExtraction,
  getCachedLink,
  isFacetEligible,
  LINKS_PREFIX,
  linkSchema,
  LISTS_PREFIX,
  listSchema,
  pathFromId,
  PINS_PREFIX,
  pinSchema,
  rekey,
  setCachedExtraction,
  setCachedLink,
  SETTINGS_GENERAL_PATH,
  settingsGeneralSchema,
  SYSTEM_LIST_DEFAULTS,
  SYSTEM_LIST_IDS,
  TAGS_PREFIX,
  tagSchema,
  TRASH_ID,
} from '@stxapps/shared';
import { chunk } from '@stxapps/shared';

import { getDb, itemFacetStatuses, items, itemTagIds } from './db';
import { dataFileFor } from './file-store';
import { bulkGetItems, getItem, type ItemRow, namespaceRows } from './item-store';
import { parseBlob } from './projection';

// The read-layer facade re-exports (web queries.ts does the same): the typed
// item bundles and the query grammar live in `@stxapps/shared`; app consumers
// read them through this layer.
export type {
  Clause,
  ExtractionItem,
  LinkItem,
  LinkQuery,
  ListClause,
  ListItem,
  PinItem,
  TagItem,
  WithPath,
} from '@stxapps/shared';
export { emptyQuery, excludeLists, linkIdOf } from '@stxapps/shared';

// A link row resolved for DISPLAY — the override-wins link↔extraction join.
// Field semantics: web-react queries.ts `LinkView`.
export type LinkView = LinkItem & {
  title?: string;
  imageId?: string;
  pageCopyId?: string;
  screenshotId?: string;
};

// One page of results — web-react queries.ts `LinksResult`, verbatim: `total`
// exact only for plain browse views, `query`/`limit` echo the page identity for
// the reader's stale-result check (use-links).
export interface LinksResult {
  links: LinkView[];
  pinnedCount: number;
  total?: number;
  hasMore: boolean;
  query: LinkQuery;
  limit: number;
}

// Keep `IN (...)` lists under SQLite's bound-variable ceiling (item-store's
// convention); exclude sets (pins) and page chunks stay well below it.
const IN_BATCH = 500;

// How many rows one keyset chunk of the filtered walk pulls while hunting for
// a page — the Dexie-cursor analogue's step size (web reads lazily; here each
// step is one bounded SELECT).
const SCAN_CHUNK = 200;

// --- decode ------------------------------------------------------------------

// Decode one `items` row into a typed entity (with its path), or `undefined`
// if its bytes are absent/unparseable — dropped from the view rather than
// crashing it. See `parseBlob` for the two skip reasons.
function decode<T extends z.ZodTypeAny>(row: ItemRow, schema: T): WithPath<z.infer<T>> | undefined {
  const parsed = parseBlob(row.data ?? undefined, schema);
  if (parsed === undefined) return undefined;
  // The entity schemas are all `looseObject`, so `parsed` is an object; TS only
  // sees the open `z.infer<T>`, hence the spread widening.
  return { ...(parsed as object), path: row.path } as WithPath<z.infer<T>>;
}

// Decode a link THROUGH the memoized cache (shared decode-cache.ts) so the live
// views' repeated re-reads don't re-run parseBlob+zod on every store write —
// same version key as web (`updatedAt`, `itemUpdatedAt`).
function decodeCachedLink(row: ItemRow): LinkItem | undefined {
  const itemUpdatedAt = row.itemUpdatedAt ?? 0;
  const cached = getCachedLink(row.path, row.updatedAt, itemUpdatedAt);
  if (cached !== undefined) return cached;

  const link = decode(row, linkSchema);
  if (link === undefined) {
    dropCachedLink(row.path); // bytes now absent/unparseable — drop any stale entry
    return undefined;
  }
  setCachedLink(row.path, row.updatedAt, itemUpdatedAt, link);
  return link;
}

function decodeLinks(rows: ItemRow[]): LinkItem[] {
  return rows
    .map((row) => decodeCachedLink(row))
    .filter((link): link is LinkItem => link !== undefined);
}

// The `extractions/` counterpart — same memoized, version-keyed decode.
function decodeCachedExtraction(row: ItemRow): ExtractionItem | undefined {
  const itemUpdatedAt = row.itemUpdatedAt ?? 0;
  const cached = getCachedExtraction(row.path, row.updatedAt, itemUpdatedAt);
  if (cached !== undefined) return cached;

  const extraction = decode(row, extractionSchema);
  if (extraction === undefined) {
    dropCachedExtraction(row.path);
    return undefined;
  }
  setCachedExtraction(row.path, row.updatedAt, itemUpdatedAt, extraction);
  return extraction;
}

// The `extractions/{id}.enc` path shadowing a link's `links/{id}.enc` — the
// writer-split's co-key (shared entities.ts); a prefix swap.
function extractionPathForLink(linkPath: string): string {
  return rekey(linkPath, LINKS_PREFIX, EXTRACTIONS_PREFIX);
}

// Resolve one link + its (optional) extraction into the display row — the
// override-wins join.
function toView(link: LinkItem, extraction: Extraction | undefined): LinkView {
  return {
    ...link,
    title: link.customTitle ?? extraction?.title,
    imageId: link.customImageId ?? extraction?.imageId,
    pageCopyId: extraction?.pageCopyId,
    screenshotId: extraction?.screenshotId,
  };
}

// Batch-join a page of links with their co-keyed extractions and resolve each
// to a display row. The page is small (one screen's window), so this is cheap.
async function joinExtractions(links: LinkItem[]): Promise<LinkView[]> {
  if (links.length === 0) return [];
  const rows = await bulkGetItems(links.map((link) => extractionPathForLink(link.path)));
  return links.map((link, i) => {
    const row = rows[i];
    const extraction = row ? decodeCachedExtraction(row) : undefined;
    return toView(link, extraction);
  });
}

// --- namespace reads (small collections) -------------------------------------

// All rows under one namespace prefix, decoded and parse-filtered (the range
// scan itself is item-store.ts's `namespaceRows`).
async function readNamespace<T extends z.ZodTypeAny>(
  prefix: string,
  schema: T,
): Promise<WithPath<z.infer<T>>[]> {
  return namespaceRows(prefix)
    .map((row) => decode(row, schema))
    .filter((entity): entity is WithPath<z.infer<T>> => entity !== undefined);
}

// Overlay the synced lists onto the system-list defaults — web queries.ts
// `mergeSystemLists`, verbatim (defaults carry a SYNTHESIZED path so the UI can
// target a not-yet-overridden system list).
function mergeSystemLists(stored: ListItem[]): ListItem[] {
  const storedById = new Map(stored.map((list) => [list.id, list]));
  const resolved: ListItem[] = SYSTEM_LIST_DEFAULTS.map(
    (def) => storedById.get(def.id) ?? { ...def, path: pathFromId(def.id, LISTS_PREFIX) },
  );
  for (const list of stored) {
    if (!SYSTEM_LIST_IDS.has(list.id)) resolved.push(list);
  }
  return resolved;
}

// The full logical list set: synced lists merged with the system defaults
// (My List / Archive / Trash). Flat — the caller assembles the tree via
// `buildTree` (see use-lists), so non-sidebar readers can take the flat set.
export async function readLists(): Promise<ListItem[]> {
  const stored = await readNamespace(LISTS_PREFIX, listSchema);
  return mergeSystemLists(stored);
}

export function readTags(): Promise<TagItem[]> {
  return readNamespace(TAGS_PREFIX, tagSchema);
}

// Every pin (one per pinned link). Small by design, like lists/tags.
export function readPins(): Promise<PinItem[]> {
  return readNamespace(PINS_PREFIX, pinSchema);
}

// The synced general-settings blob, or undefined if this device hasn't
// synced/written one. Callers default each field (see use-settings).
export async function readSettingsGeneral(): Promise<SettingsGeneral | undefined> {
  const row = getDb().select().from(items).where(eq(items.path, SETTINGS_GENERAL_PATH)).get();
  return parseBlob(row?.data ?? undefined, settingsGeneralSchema);
}

// How many links currently belong to `listId`, counted straight off the
// `item_list_id` column — no blob decode (web's countLinksInList, over the
// same projected column its list views range on). The "is this list empty?"
// gate for deleting a list: a list with links can't be removed (see
// use-list-mutations), since deleting it would orphan them.
export async function countLinksInList(listId: string): Promise<number> {
  const row = getDb().select({ n: count() }).from(items).where(eq(items.itemListId, listId)).get();
  return row?.n ?? 0;
}

// Every link in the local store, counted trash-INCLUSIVELY: every `links/`
// record, including trashed ones (Trash is a listId, not a deletion — the blob
// still exists). The link cap's count (see use-link-quota, whose header carries
// the rationale for why the cap is client-enforced); the same rule as
// readExistingLinks in import-all-data.ts and isAtLinkCap in share-store.ts,
// which all have to agree. An indexed COUNT — no blob decode.
//
// Counted off `item_type` rather than a `links/` path range: projection.ts
// stamps the column from the path prefix BEFORE its early returns, so every
// `links/` row carries it — including the blob-less and unparseable ones a
// path range would catch — making the two sets identical. This one is the
// same predicate the all-links browse view drives on (readRest), rides the
// partial `idx_items_type_item_created_at` (`= 'link'` implies its
// `IS NOT NULL`), and can't drift from the prefix constants.
export async function countLinks(): Promise<number> {
  const row = getDb().select({ n: count() }).from(items).where(eq(items.itemType, 'link')).get();
  return row?.n ?? 0;
}

// One link looked up by its exact stored URL, or undefined — web
// readLinkByUrl's port (that header is canonical: exact match by design; for
// "is this URL already saved?" use readLinkByUrlKey). Served by the partial
// `idx_items_url` index (db.ts); `itemUrl` is links-only (projection.ts), so
// the hit is a link.
export async function readLinkByUrl(url: string): Promise<LinkItem | undefined> {
  const row = getDb().select().from(items).where(eq(items.itemUrl, url)).limit(1).get();
  return row ? decodeCachedLink(row) : undefined;
}

// One link that's the SAME RESOURCE as `url` under the canonical dedup
// identity (canonicalUrlKey), or undefined — web readLinkByUrlKey's port (that
// header is canonical: why the URL is keyed here, the raw-text fallback). The
// add editor's duplicate/trashed check; served by the partial
// `idx_items_url_key` index over the column projection.ts stamps at write.
export async function readLinkByUrlKey(url: string): Promise<LinkItem | undefined> {
  const key = canonicalUrlKey(url);
  if (key === null) return readLinkByUrl(url);

  const row = getDb().select().from(items).where(eq(items.itemUrlKey, key)).limit(1).get();
  return row ? decodeCachedLink(row) : undefined;
}

// One link by its id (the `{id}` of its `links/{id}.enc`), or undefined — the
// direct-path lookup behind the write edge's re-read-before-merge
// (use-link-mutations.update/destroy). An exact-path read + cached decode.
export async function readLinkById(linkId: string): Promise<LinkItem | undefined> {
  const row = await getItem(pathFromId(linkId, LINKS_PREFIX));
  if (!row) return undefined;
  return decodeCachedLink(row);
}

// The extraction bookkeeping entity for one link id, or undefined if none has
// synced/been written yet — web's readExtraction, verbatim: a direct
// exact-path read + cached decode (the path is derived from the id, no scan).
export async function readExtraction(linkId: string): Promise<ExtractionItem | undefined> {
  const row = await getItem(pathFromId(linkId, EXTRACTIONS_PREFIX));
  if (!row) return undefined;
  return decodeCachedExtraction(row);
}

// The local plaintext `file://` uri for a `files/{id}` content blob, or
// undefined if this device hasn't materialized it — the platform's
// readFileBytes analogue (web hands back the row's bytes; here content lives
// decrypted ON DISK — file-store.ts — and the render path is the uri, not
// bytes in the JS heap). LOCAL ONLY by design, like web's: no network, no
// decrypt — a not-yet-downloaded blob is simply "absent" (the sync engine's
// loadEntityContent is the download-if-missing path). Both halves are checked
// — the row's `hasDataFile` bookkeeping AND the file's existence — so a
// half-materialized crash state reads as absent, never as a broken uri.
export async function readFileUri(fileId: string): Promise<string | undefined> {
  const path = pathFromId(fileId, FILES_PREFIX);
  const row = await getItem(path);
  if (!row?.hasDataFile) return undefined;
  const file = dataFileFor(path);
  return file.exists ? file.uri : undefined;
}

// --- extraction: tallies + the pending drain queue ---------------------------
//
// The reads behind bracemark-expo's on-device extraction (docs/link-extraction.md —
// _expo drains in the foreground_): the drain's wake signal, the Settings tally, and
// the two pending-work queries (whole-library for "Generate all", displayed-scoped for
// the automatic drain). Ports of web-react's, with ONE deliberate divergence: web
// scans links in chunks and tests each one's facet in JS because Dexie can't express
// the anti-join, while SQLite can — so "pending" is a `NOT EXISTS` against the co-keyed
// extraction's settled tokens (`item_facet_statuses`, projection.ts), and a blob is
// decoded ONLY for the `failed` rows whose backoff has to be read. Absence-is-pending
// (the writer-split, entities.ts) is what makes that expressible: a link with no
// extraction row simply has no token to find.

// The `extractions/{id}.enc` path co-keyed to an `items` row's `links/{id}.enc` path,
// in SQL — `extractionPathForLink` above, expressed so the correlation can happen in
// the database. The prefix lengths come from the constants (never a literal `7`), so a
// namespace rename can't silently desync this from `rekey`.
const extractionPathSql = sql`${EXTRACTIONS_PREFIX} || substr(${items.path}, ${LINKS_PREFIX.length + 1})`;

// The settled `titleImage` outcomes — a facet in one of these states is never
// re-extracted by the normal loop (`done`/`permanent` are terminal; `failed` is settled
// only until its backoff cools, which is the one case that needs the blob).
const DONE_TOKEN = 'done:titleImage';
const FAILED_TOKEN = 'failed:titleImage';
const PERMANENT_TOKEN = 'permanent:titleImage';

// "This link's extraction carries one of `tokens` for titleImage" — the correlated
// subquery both the tally join and the pending scan build on.
function hasTitleImageToken(tokens: string[]): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${itemFacetStatuses}
    WHERE ${and(
      eq(itemFacetStatuses.path, extractionPathSql),
      inArray(itemFacetStatuses.token, tokens),
    )}
  )`;
}

function countToken(token: string): number {
  const row = getDb()
    .select({ n: count() })
    .from(itemFacetStatuses)
    .where(eq(itemFacetStatuses.token, token))
    .get();
  return row?.n ?? 0;
}

// The RAW pending-titleImage count: links minus recorded outcomes — four index counts,
// no decode, no join. "Raw" because Trash is NOT folded out, which is sound for its one
// consumer, the drain's WAKE SIGNAL: a trashed link's outcome token cancels against its
// own entry in the link total, so the result is exactly livePending + trashedPending —
// a strict OVER-count, never an under-count. 0 therefore always means "nothing to do"
// (safe to stay asleep); a rare trashed-pending false positive just walks the library
// once, finds nothing eligible (the walk skips Trash inline) and ends the job. The
// exact, trash-corrected tally for DISPLAY is readExtractionFacetCounts.
export async function readRawPendingTitleImageCount(): Promise<number> {
  const total = await countLinks();
  const settled = countToken(DONE_TOKEN) + countToken(FAILED_TOKEN) + countToken(PERMANENT_TOKEN);
  return Math.max(0, total - settled);
}

// The Settings section's tally, headlined on `titleImage` (the "fill in title + image"
// job). `failed` folds in `permanent` — both are "not extracted, won't auto-retry
// without help". Field semantics: web-react queries.ts `ExtractionFacetCounts`.
export interface ExtractionFacetCounts {
  done: number;
  pending: number;
  failed: number;
}

// The trash correction, as ONE aggregate instead of web's O(trash) read-and-decode
// join: trashed links are excluded from all three buckets to match the drains (which
// skip Trash), or the section would show a Pending stat that never drops and a
// "Generate all" button that drains nothing. Web pays a per-trashed-link blob decode
// because its two terms live on DIFFERENT RECORDS of its single `items` store —
// `itemListId` on the link, the status tokens on the co-keyed extraction — and IndexedDB
// can't join; the same correlation is a LEFT JOIN on the token junction here, so nothing
// is decoded at all.
function readTrashedTitleImageCounts(): { total: number; done: number; failed: number } {
  // The join is restricted to the three titleImage tokens, so at most ONE junction row
  // can match a link (a facet has exactly one status) and `COUNT(*)` stays the trashed
  // LINK count — an unrestricted join would multiply each link by its other facets'
  // tokens (`done:screenshot`, …) and inflate every term.
  const row = getDb()
    .select({
      total: count(),
      done: sql<number>`SUM(CASE WHEN ${itemFacetStatuses.token} = ${DONE_TOKEN} THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN ${itemFacetStatuses.token} IN (${FAILED_TOKEN}, ${PERMANENT_TOKEN}) THEN 1 ELSE 0 END)`,
    })
    .from(items)
    .leftJoin(
      itemFacetStatuses,
      and(
        eq(itemFacetStatuses.path, extractionPathSql),
        inArray(itemFacetStatuses.token, [DONE_TOKEN, FAILED_TOKEN, PERMANENT_TOKEN]),
      ),
    )
    .where(eq(items.itemListId, TRASH_ID))
    .get();
  // SUM over zero rows is NULL — normalize (COUNT is already 0).
  return { total: row?.total ?? 0, done: row?.done ?? 0, failed: row?.failed ?? 0 };
}

export async function readExtractionFacetCounts(): Promise<ExtractionFacetCounts> {
  const trashed = readTrashedTitleImageCounts();
  const totalLinks = await countLinks();
  // Each term drops its trashed share, so the three still sum to the live link total —
  // the section renders `done + pending + failed` as the total.
  const liveLinks = totalLinks - trashed.total;
  const liveDone = countToken(DONE_TOKEN) - trashed.done;
  const liveFailed = countToken(FAILED_TOKEN) + countToken(PERMANENT_TOKEN) - trashed.failed;
  return {
    done: liveDone,
    failed: liveFailed,
    pending: Math.max(0, liveLinks - liveDone - liveFailed),
  };
}

// A position in the newest-first `links/` walk — web queries.ts `LinkScanCursor`,
// verbatim, including WHY `path` is part of it: equal `createdAt` rows are ordered by
// path, and a bulk import stamps many links the same millisecond, so `createdAt` alone
// couldn't pin a resume point.
export interface LinkScanCursor {
  createdAt: number;
  path: string;
}

// One page of the "Generate all" walk: up to `limit` pending+eligible links
// (newest-first) plus the cursor to resume from. `cursor === null` means the library is
// exhausted; a non-null cursor always pairs with a FULL page, so the caller keeps
// paging while it's non-null.
export interface PendingTitleImagePage {
  links: LinkItem[];
  cursor: LinkScanCursor | null;
}

// One chunk of link rows that are NOT settled for `titleImage`, newest-first, resuming
// strictly past `after`. The `NOT EXISTS` is the whole point: `done`/`permanent` links
// never leave SQLite, so the JS pass below only ever sees genuine candidates. The
// `failed` token rides along in the projection so the caller knows which rows still
// need a blob read for their backoff.
function scanUnsettledLinks(
  after: LinkScanCursor | undefined,
  limit: number,
): { path: string; createdAt: number; failed: boolean }[] {
  const rows = getDb()
    .select({
      path: items.path,
      createdAt: items.itemCreatedAt,
      failed: hasTitleImageToken([FAILED_TOKEN]).mapWith(Number),
    })
    .from(items)
    .where(
      and(
        eq(items.itemType, 'link'),
        // Trash gets no extraction work (see the header); `IS NULL` keeps a link whose
        // list column somehow never projected rather than silently dropping it.
        sql`(${items.itemListId} IS NULL OR ${items.itemListId} <> ${TRASH_ID})`,
        sql`NOT ${hasTitleImageToken([DONE_TOKEN, PERMANENT_TOKEN])}`,
        after
          ? sql`(${items.itemCreatedAt} < ${after.createdAt} OR (${items.itemCreatedAt} = ${after.createdAt} AND ${items.path} < ${after.path}))`
          : undefined,
      ),
    )
    .orderBy(desc(items.itemCreatedAt), desc(items.path))
    .limit(limit)
    .all();

  return rows.map((row) => ({
    path: row.path,
    createdAt: row.createdAt ?? 0,
    failed: row.failed === 1,
  }));
}

// The residual extraction queue for the WHOLE-LIBRARY job (extraction-provider's
// `extractAll`), as a QUERY — there's no queue object (docs/link-extraction.md — _the
// queue is a query_) — PAGINATED by a forward cursor so a full drain is O(library),
// not O(library²): each batch resumes where the last stopped, and a just-extracted link
// sits behind the cursor.
//
// Trashed links are skipped (they're excluded from every browse view, so extracting one
// fills in a title the user can only see by restoring the link first). Eligibility is
// tested FRESH per row, so a link another device settled mid-drain drops out here.
export async function readLinksPendingTitleImagePage(
  now: number,
  limit: number,
  cursor?: LinkScanCursor,
): Promise<PendingTitleImagePage> {
  if (limit <= 0) return { links: [], cursor: cursor ?? null };

  const pending: string[] = [];
  let scannedFrom = cursor;
  let scannedTo: LinkScanCursor | null = cursor ?? null;

  for (;;) {
    const chunkRows = scanUnsettledLinks(scannedFrom, SCAN_CHUNK);
    if (chunkRows.length === 0) return { links: await loadLinks(pending), cursor: null };

    // Only the `failed` rows need their blob: everything else in this chunk is pending
    // by ABSENCE, which the SQL already proved.
    const cooling = new Set<string>();
    const failedPaths = chunkRows.filter((r) => r.failed).map((r) => extractionPathForLink(r.path));
    if (failedPaths.length > 0) {
      const exRows = await bulkGetItems(failedPaths);
      exRows.forEach((exRow, i) => {
        const facet = exRow ? decodeCachedExtraction(exRow)?.facets.titleImage : undefined;
        if (!isFacetEligible(facet, now)) cooling.add(failedPaths[i]);
      });
    }

    for (const row of chunkRows) {
      scannedTo = { createdAt: row.createdAt, path: row.path };
      if (cooling.has(extractionPathForLink(row.path))) continue;
      pending.push(row.path);
      if (pending.length >= limit) return { links: await loadLinks(pending), cursor: scannedTo };
    }

    // A short chunk means the oldest link was reached — library exhausted.
    if (chunkRows.length < SCAN_CHUNK) return { links: await loadLinks(pending), cursor: null };
    scannedFrom = scannedTo ?? undefined;
  }
}

// Decode a set of link paths, in the given order, dropping anything unreadable.
async function loadLinks(paths: string[]): Promise<LinkItem[]> {
  if (paths.length === 0) return [];
  const rows = await bulkGetItems(paths);
  return decodeLinks(rows.filter((row): row is ItemRow => row !== undefined));
}

// The pending-titleImage subset of a SPECIFIC set of link paths, in the given order —
// the read behind the AUTOMATIC (displayed-scoped) drain. Where the page read above
// walks the whole library for the conscious "Generate all" job, this scopes automatic
// work to what the user is actually looking at, so a 30k-link import left open never
// extracts past what was scrolled into view.
//
// Cost: O(displayed), NOT O(library) — load-bearing, because this backs the always-on
// wake read (extraction-provider), which re-runs on every `items` change. Two batch
// gets (the links + their co-keyed extractions), then an inline eligibility test.
// Missing / non-link / trashed / settled / still-cooling paths drop out — Trash is
// filtered HERE rather than asked of each caller, so browsing Trash can't become the
// one way to spend extraction work on links the user removed.
export async function readLinksPendingTitleImageForLinkPaths(
  linkPaths: string[],
  now: number,
): Promise<LinkItem[]> {
  if (linkPaths.length === 0) return [];

  const [rows, exRows] = await Promise.all([
    bulkGetItems(linkPaths),
    bulkGetItems(linkPaths.map(extractionPathForLink)),
  ]);

  const pending: ItemRow[] = [];
  for (let i = 0; i < linkPaths.length; i++) {
    const row = rows[i];
    if (!row || row.itemType !== 'link' || row.itemListId === TRASH_ID) continue;

    const exRow = exRows[i];
    const facet = exRow ? decodeCachedExtraction(exRow)?.facets.titleImage : undefined;
    if (isFacetEligible(facet, now)) pending.push(row);
  }
  return decodeLinks(pending);
}

// --- link query --------------------------------------------------------------

function clauseEmpty(c: Clause): boolean {
  return c.any.length === 0 && c.all.length === 0 && c.none.length === 0;
}

function hasTextClause(q: LinkQuery): boolean {
  return !clauseEmpty(q.url) || !clauseEmpty(q.title) || !clauseEmpty(q.text);
}

// The tag-id sets for a set of link paths, from the junction table — the
// column predicates' stand-in for web's `record.itemTagIds` array. Only built
// when a tag clause needs it; paths without tags simply miss the map.
function loadTagIdsByPath(paths: string[]): Map<string, string[]> {
  const byPath = new Map<string, string[]>();
  for (const batch of chunk(paths, IN_BATCH)) {
    const rows = getDb().select().from(itemTagIds).where(inArray(itemTagIds.path, batch)).all();
    for (const row of rows) {
      const tags = byPath.get(row.path);
      if (tags) tags.push(row.tagId);
      else byPath.set(row.path, [row.tagId]);
    }
  }
  return byPath;
}

// Predicates the projected COLUMNS can answer without decoding the blob — web
// queries.ts `columnMatches`, with the tag set passed in (junction map) instead
// of read off the record. The driver pre-narrows for one positive clause; this
// re-checks every clause so it's correct no matter which (or no) driver ran.
function columnMatches(row: ItemRow, tagIds: readonly string[], q: LinkQuery): boolean {
  const listId = row.itemListId;
  if (q.lists.any.length > 0 && (listId === null || !q.lists.any.includes(listId))) {
    return false;
  }
  if (q.lists.none.length > 0 && listId !== null && q.lists.none.includes(listId)) {
    return false;
  }
  if (q.tags.any.length > 0 && !q.tags.any.some((t) => tagIds.includes(t))) return false;
  if (q.tags.all.length > 0 && !q.tags.all.every((t) => tagIds.includes(t))) return false;
  if (q.tags.none.length > 0 && q.tags.none.some((t) => tagIds.includes(t))) return false;
  return true;
}

// Whether the query carries any tag clause at all — the gate for building the
// junction map the predicates above would read.
function hasTagClause(q: LinkQuery): boolean {
  return !clauseEmpty(q.tags);
}

// Substring word match over one field. Words are pre-lowercased by the parser;
// the haystack is lowercased here.
function wordsMatch(haystack: string, c: Clause): boolean {
  const h = haystack.toLowerCase();
  if (c.all.length > 0 && !c.all.every((w) => h.includes(w))) return false;
  if (c.any.length > 0 && !c.any.some((w) => h.includes(w))) return false;
  if (c.none.length > 0 && c.none.some((w) => h.includes(w))) return false;
  return true;
}

// A query needs the link↔extraction JOIN when it filters on the resolved title
// (`title`, or `text` whose haystack includes it) — web queries.ts, verbatim.
function needsExtractionJoin(q: LinkQuery): boolean {
  return !clauseEmpty(q.title) || !clauseEmpty(q.text);
}

function urlMatches(link: LinkItem, q: LinkQuery): boolean {
  return wordsMatch(link.url, q.url);
}

function titleMatches(link: LinkItem, extraction: Extraction | undefined, q: LinkQuery): boolean {
  return wordsMatch(link.customTitle ?? extraction?.title ?? '', q.title);
}

function textMatches(link: LinkItem, extraction: Extraction | undefined, q: LinkQuery): boolean {
  const title = link.customTitle ?? extraction?.title ?? '';
  return wordsMatch(`${link.url} ${title}`, q.text);
}

// The sort column backing each sort dimension (db.ts's compound indexes cover
// (item_type|item_list_id, <column>)). `IS NOT NULL` on it in every ordered
// scan reproduces web's sparse compound index, which simply omits records
// without the column.
function sortColumnOf(sortOn: LinkSortOn) {
  return sortOn === 'createdAt' ? items.itemCreatedAt : items.itemUpdatedAt;
}

// A browse view with a single positive list/all clause and nothing else: one
// ordered indexed SELECT for the page and one index COUNT for the exact total
// (web's `rangeFastPath`). `exclude` (the pinned overlay) is folded in as a
// NOT IN on the page read and subtracted from the count — every excluded path
// falls in this range (it matched the same query), exactly as on web.
async function rangeFastPath(
  where: SQL,
  q: LinkQuery,
  limit: number,
  exclude: Set<string>,
): Promise<RestResult> {
  const sortCol = sortColumnOf(q.sortOn);
  const order = q.sortOrder === 'desc' ? desc : asc;
  const filters = and(
    where,
    isNotNull(sortCol),
    exclude.size > 0 ? notInArray(items.path, [...exclude]) : undefined,
  );
  const rows = getDb()
    .select()
    .from(items)
    .where(filters)
    .orderBy(order(sortCol), order(items.path))
    .limit(limit)
    .all();
  const totalRow = getDb()
    .select({ n: count() })
    .from(items)
    .where(and(where, isNotNull(sortCol)))
    .get();
  const restTotal = (totalRow?.n ?? 0) - exclude.size;
  return { links: decodeLinks(rows), total: restTotal, hasMore: restTotal > limit };
}

// Finish a query from an already-loaded candidate subset (the tag-driven
// path) — web's `finishFromCandidates`: drop non-matches on the columns (no
// decode), sort by the chosen sort column, decode only as far as the page
// needs. Exact total when there's no text clause.
async function finishFromCandidates(
  candidates: ItemRow[],
  tagIdsByPath: Map<string, string[]>,
  q: LinkQuery,
  limit: number,
  exclude: Set<string>,
): Promise<RestResult> {
  const column = q.sortOn === 'createdAt' ? 'itemCreatedAt' : 'itemUpdatedAt';
  const descOrder = q.sortOrder === 'desc';
  const survivors = candidates.filter(
    (r) => !exclude.has(r.path) && columnMatches(r, tagIdsByPath.get(r.path) ?? [], q),
  );
  survivors.sort((a, b) => {
    const av = a[column] ?? 0;
    const bv = b[column] ?? 0;
    if (av !== bv) return descOrder ? bv - av : av - bv;
    // Path tiebreak, matching the ordered-index scans' explicit `path` order.
    return descOrder ? (a.path < b.path ? 1 : -1) : a.path < b.path ? -1 : 1;
  });

  if (!hasTextClause(q)) {
    return {
      links: decodeLinks(survivors.slice(0, limit)),
      total: survivors.length,
      hasMore: survivors.length > limit,
    };
  }

  if (needsExtractionJoin(q)) return finishWithExtractionSearch(survivors, q, limit);

  // url-only text: filter on the decoded link, no extraction join needed.
  const links: LinkItem[] = [];
  for (const row of survivors) {
    const link = decodeCachedLink(row);
    if (link && urlMatches(link, q)) {
      links.push(link);
      if (links.length > limit) break; // one past the page → hasMore
    }
  }
  return { links: links.slice(0, limit), total: undefined, hasMore: links.length > limit };
}

// Finish an EXTRACTION-dependent search page (`title`/`text` clause) — web's
// `finishWithExtractionSearch`: url-filter the decoded survivors, bulk-join
// their extractions, apply the title + text clauses, page.
async function finishWithExtractionSearch(
  survivors: ItemRow[],
  q: LinkQuery,
  limit: number,
): Promise<RestResult> {
  const urlPassed: LinkItem[] = [];
  for (const row of survivors) {
    const link = decodeCachedLink(row);
    if (link && urlMatches(link, q)) urlPassed.push(link);
  }
  const exRows = await bulkGetItems(urlPassed.map((l) => extractionPathForLink(l.path)));
  const links: LinkItem[] = [];
  for (let i = 0; i < urlPassed.length; i++) {
    const exRow = exRows[i];
    const extraction = exRow ? decodeCachedExtraction(exRow) : undefined;
    if (titleMatches(urlPassed[i], extraction, q) && textMatches(urlPassed[i], extraction, q)) {
      links.push(urlPassed[i]);
      if (links.length > limit) break; // one past the page → hasMore
    }
  }
  return { links: links.slice(0, limit), total: undefined, hasMore: links.length > limit };
}

// The page of NON-pinned links before the pinned overlay is prepended and the
// page identity is stamped — web's `RestResult`, verbatim.
interface RestResult {
  links: LinkItem[];
  total?: number;
  hasMore: boolean;
}

// One keyset-ordered chunk of the all-links scan: rows strictly AFTER
// `(afterValue, afterPath)` in the sort order, `IS NOT NULL` on the sort
// column (the sparse-index analogue). The explicit `(column, path)` compare is
// what lets the next chunk resume without overlap — the SQLite form of
// advancing a Dexie cursor.
function scanChunk(q: LinkQuery, after: { value: number; path: string } | undefined): ItemRow[] {
  const sortCol = sortColumnOf(q.sortOn);
  const descOrder = q.sortOrder === 'desc';
  const order = descOrder ? desc : asc;
  let cursorCond: SQL | undefined;
  if (after) {
    cursorCond = descOrder
      ? sql`(${sortCol} < ${after.value} OR (${sortCol} = ${after.value} AND ${items.path} < ${after.path}))`
      : sql`(${sortCol} > ${after.value} OR (${sortCol} = ${after.value} AND ${items.path} > ${after.path}))`;
  }
  return getDb()
    .select()
    .from(items)
    .where(and(eq(items.itemType, 'link'), isNotNull(sortCol), cursorCond))
    .orderBy(order(sortCol), order(items.path))
    .limit(SCAN_CHUNK)
    .all();
}

// One page of the link library for `query` MINUS `exclude` — web's `readRest`:
// same driver choices, same totals policy.
//   - single list / no filters → indexed fast path (exact count).
//   - positive tag clause → drive the junction, finish over that subset.
//   - anything else → keyset-chunked ordered walk applying every clause,
//     stopping at the page; total is non-exact.
async function readRest(
  query: LinkQuery,
  limit: number,
  exclude: Set<string>,
): Promise<RestResult> {
  const onlyLists =
    clauseEmpty(query.tags) &&
    clauseEmpty(query.url) &&
    clauseEmpty(query.title) &&
    clauseEmpty(query.text);

  if (onlyLists && query.lists.none.length === 0) {
    if (query.lists.any.length === 1) {
      return rangeFastPath(eq(items.itemListId, query.lists.any[0]), query, limit, exclude);
    }
    if (query.lists.any.length === 0) {
      return rangeFastPath(eq(items.itemType, 'link'), query, limit, exclude);
    }
  }

  // Most selective positive clause is a tag: drive the junction. `any` is an OR
  // membership; for an `all`-only query we drive on the first tag and let
  // `columnMatches` enforce the rest — web's tagDriver, verbatim.
  const tagDriver = query.tags.any.length > 0 ? query.tags.any : query.tags.all.slice(0, 1);
  if (tagDriver.length > 0) {
    const pathRows = getDb()
      .selectDistinct({ path: itemTagIds.path })
      .from(itemTagIds)
      .where(inArray(itemTagIds.tagId, tagDriver))
      .all();
    const candidates = (await bulkGetItems(pathRows.map((r) => r.path))).filter(
      (row): row is ItemRow => row !== undefined,
    );
    const tagIdsByPath = loadTagIdsByPath(candidates.map((r) => r.path));
    return finishFromCandidates(candidates, tagIdsByPath, query, limit, exclude);
  }

  // A title/text clause can't be filtered without the join: gather every
  // column-filtered survivor in sort order (chunked walk), then join + filter +
  // page — the same materialization web pays for this search.
  if (needsExtractionJoin(query)) {
    const survivors: ItemRow[] = [];
    let after: { value: number; path: string } | undefined;
    for (;;) {
      const rows = scanChunk(query, after);
      if (rows.length === 0) break;
      const tagIdsByPath = hasTagClause(query)
        ? loadTagIdsByPath(rows.map((r) => r.path))
        : undefined;
      for (const row of rows) {
        if (exclude.has(row.path)) continue;
        if (columnMatches(row, tagIdsByPath?.get(row.path) ?? [], query)) survivors.push(row);
      }
      if (rows.length < SCAN_CHUNK) break;
      const last = rows[rows.length - 1];
      after = { value: sortValueOf(last, query.sortOn), path: last.path };
    }
    return finishWithExtractionSearch(survivors, query, limit);
  }

  // No positive tag clause and no title/text clause: walk all links in sort
  // order, filtering as we go on columns + url (decoded link), stopping once
  // `limit + 1` pass — a bounded slice, not the library.
  const passed: ItemRow[] = [];
  let after: { value: number; path: string } | undefined;
  outer: for (;;) {
    const rows = scanChunk(query, after);
    if (rows.length === 0) break;
    const tagIdsByPath = hasTagClause(query)
      ? loadTagIdsByPath(rows.map((r) => r.path))
      : undefined;
    for (const row of rows) {
      if (exclude.has(row.path)) continue;
      if (!columnMatches(row, tagIdsByPath?.get(row.path) ?? [], query)) continue;
      const link = decodeCachedLink(row);
      if (link === undefined || !urlMatches(link, query)) continue;
      passed.push(row);
      if (passed.length > limit) break outer; // one past the page → hasMore
    }
    if (rows.length < SCAN_CHUNK) break;
    const last = rows[rows.length - 1];
    after = { value: sortValueOf(last, query.sortOn), path: last.path };
  }

  return {
    links: decodeLinks(passed).slice(0, limit),
    total: undefined,
    hasMore: passed.length > limit,
  };
}

function sortValueOf(row: ItemRow, sortOn: LinkSortOn): number {
  return (sortOn === 'createdAt' ? row.itemCreatedAt : row.itemUpdatedAt) ?? 0;
}

// The pinned links that MATCH `query`, in pin-rank order — web's
// `readPinnedOverlay`: read the small `pins/` namespace, look up each pin's
// link row (bulkGetItems preserves rank order), keep those that pass the same
// column + text predicates the rest of the query uses.
async function readPinnedOverlay(
  query: LinkQuery,
): Promise<{ links: LinkItem[]; paths: Set<string> }> {
  const pins = (await readPins()).sort(compareRank);
  if (pins.length === 0) return { links: [], paths: new Set() };

  const rows = await bulkGetItems(pins.map((pin) => pathFromId(pin.id, LINKS_PREFIX)));
  const present = rows.filter((row): row is ItemRow => row !== undefined);
  const tagIdsByPath = hasTagClause(query)
    ? loadTagIdsByPath(present.map((r) => r.path))
    : undefined;
  const hasUrl = !clauseEmpty(query.url);
  const passed: LinkItem[] = [];
  for (const row of rows) {
    if (!row || !columnMatches(row, tagIdsByPath?.get(row.path) ?? [], query)) continue;
    const link = decodeCachedLink(row);
    if (!link || (hasUrl && !urlMatches(link, query))) continue;
    passed.push(link);
  }

  if (!needsExtractionJoin(query)) {
    return { links: passed, paths: new Set(passed.map((l) => l.path)) };
  }

  // Title/text clause: join each pinned link's extraction (pins are few).
  const exRows = await bulkGetItems(passed.map((l) => extractionPathForLink(l.path)));
  const links: LinkItem[] = [];
  passed.forEach((link, i) => {
    const exRow = exRows[i];
    const extraction = exRow ? decodeCachedExtraction(exRow) : undefined;
    if (titleMatches(link, extraction, query) && textMatches(link, extraction, query)) {
      links.push(link);
    }
  });
  return { links, paths: new Set(links.map((l) => l.path)) };
}

// One page for `query`: the pinned matching links first (rank order, always
// whole), then the page of the rest — web's `readLinks`, minus the zone-echo
// wraps (no Dexie zone here; see the header).
export async function readLinks(query: LinkQuery, limit: number): Promise<LinksResult> {
  const overlay = await readPinnedOverlay(query);
  const rest = await readRest(query, limit, overlay.paths);
  // Join the whole page (overlay + rest) with extractions in one pass → display rows.
  const links = await joinExtractions([...overlay.links, ...rest.links]);
  return {
    links,
    pinnedCount: overlay.links.length,
    total: rest.total === undefined ? undefined : overlay.links.length + rest.total,
    hasMore: rest.hasMore,
    query,
    limit,
  };
}
