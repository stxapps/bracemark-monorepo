'use client';

// The typed read layer over the `items` store (db.ts): turns the sync engine's
// payload-agnostic blobs into typed entities for the UI, and runs the link
// library's queries. Shares `parseBlob` with the write-edge projector
// (projection.ts), so a record decodes by identical rules wherever it's read.
//
// Lives in `src/data/` (not the links route) because it's not links-specific —
// settings reads lists/tags here too. It depends on NOTHING in `app/`: a query
// is described by the plain `LinkQuery` below, and the links route maps its URL
// onto that (page-provider `parseLinkQuery`), so the dependency points
// route → data, never the reverse.

import Dexie from 'dexie';
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
  mergeSystemLists,
  pathFromId,
  pathIdentifiedList,
  pathIdentifiedTag,
  PINS_PREFIX,
  pinSchema,
  rekey,
  setCachedExtraction,
  setCachedLink,
  SETTINGS_GENERAL_PATH,
  settingsGeneralSchema,
  TAGS_PREFIX,
  tagSchema,
  TRASH_ID,
} from '@stxapps/shared';

import { db, type ItemRecord } from './db';
import { parseBlob } from './projection';

// The typed item bundles (`WithPath` = decoded entity + its `items` path) and
// `linkIdOf` now live in `@stxapps/shared` (sync/items.ts) — the cross-platform
// contract beside the entity shapes (entities.ts) and the path↔id math (paths.ts).
// Re-exported here so the web-react data-layer surface (and its barrel) keeps
// carrying them for app consumers, which read the read layer as their facade.
export type {
  ExtractionItem,
  LinkItem,
  ListItem,
  PinItem,
  TagItem,
  WithPath,
} from '@stxapps/shared';
export { linkIdOf } from '@stxapps/shared';

// A link row resolved for DISPLAY: the user-authored link joined with its
// machine-derived `extractions/{id}.enc` (the writer-split — docs/link-extraction.md).
// The UI reads these resolved fields. `title`/`imageId` apply the override-wins rule
// (`customTitle ?? extraction.title`, `customImageId ?? extraction.imageId`); the heavy
// refs come straight from the extraction. A link with no extraction yet resolves
// `title`/`imageId` to `customTitle`/`customImageId` (or `undefined` → the view falls
// back to the URL host).
export interface LinkViewFields {
  title?: string;
  imageId?: string;
  pageCopyId?: string;
  screenshotId?: string;
}
export type LinkView = LinkItem & LinkViewFields;

// --- the query grammar -------------------------------------------------------

// The grammar (`Clause`/`ListClause`/`LinkQuery`, `emptyQuery`) moved to
// `@stxapps/shared` (sync/link-query.ts) when bracemark-expo grew its own read
// layer — it's the cross-platform contract both engines evaluate, like the
// typed item bundles above. Re-exported here so the web-react data-layer
// surface (and its barrel) keeps carrying it for app consumers.
export type { Clause, LinkQuery, ListClause } from '@stxapps/shared';
export { emptyQuery } from '@stxapps/shared';

// One page of results. `total` is the exact match count ONLY when it's a cheap
// index `.count()` (a plain browse view); it's `undefined` once any predicate
// runs in JS (text words — they can't be counted without decoding the whole
// match set), so the UI shows a non-exact count under search. `hasMore` is always
// known (the query fetches one past the page to detect it).
export interface LinksResult {
  // Pinned matching links FIRST (in pin-rank order), then the page of the rest.
  // Display-resolved (link joined with its extraction — see LinkView).
  links: LinkView[];
  // How many leading entries of `links` are pinned — the boundary the UI draws its
  // pinned section / "move up·down" affordances at. The pinned segment is always
  // returned whole (pins are few); `limit`/"show more" pages only the rest.
  pinnedCount: number;
  total?: number;
  hasMore: boolean;
  // The page identity this result was computed for — the exact `query`/`limit`
  // passed to `readLinks`, echoed back so a reader can tell whether a result
  // reflects the page it currently wants vs. a stale one from before a query/limit
  // change (useLiveQuery returns the previous result for one render after its deps
  // change). See use-links.ts.
  query: LinkQuery;
  limit: number;
}

// --- query composition -------------------------------------------------------

// `excludeLists` (fold a set of list ids — e.g. lock coverage — out of a query
// while preserving readRest's fast path) moved to shared with the grammar it
// transforms; see sync/link-query.ts and use-links for the policy that drives
// it. Re-exported for the same facade reason as the grammar above.
export { excludeLists } from '@stxapps/shared';

// --- decode ------------------------------------------------------------------

// Decode one `items` record into a typed entity (with its path), or `undefined`
// if its bytes are absent/unparseable — dropped from the view rather than
// crashing it. See `parseBlob` for the two skip reasons.
function decode<T extends z.ZodTypeAny>(
  record: ItemRecord,
  schema: T,
): WithPath<z.infer<T>> | undefined {
  const parsed = parseBlob(record.data, schema);
  if (parsed === undefined) return undefined;
  // The entity schemas are all `looseObject`, so `parsed` is an object; TS only
  // sees the open `z.infer<T>`, hence the spread widening.
  return { ...(parsed as object), path: record.path } as WithPath<z.infer<T>>;
}

// Decode a link THROUGH the memoized cache (decode-cache.ts), so the live views'
// repeated re-reads of the loaded prefix don't re-run parseBlob+zod on every
// `items` write — only records whose bytes changed re-decode. The version is the
// pair (`updatedAt`, `itemUpdatedAt`): a server rewrite moves the former, a local
// edit (which freezes `updatedAt` at its sync base) moves the latter. See
// decode-cache.ts for the full version-key rationale and the sign-out clear.
// `itemUpdatedAt` is set by the projector whenever the link parses (projection.ts);
// `?? 0` is defensive for a record that won't decode anyway.
function decodeCachedLink(record: ItemRecord): LinkItem | undefined {
  const itemUpdatedAt = record.itemUpdatedAt ?? 0;
  const cached = getCachedLink(record.path, record.updatedAt, itemUpdatedAt);
  if (cached !== undefined) return cached;

  const link = decode(record, linkSchema);
  if (link === undefined) {
    dropCachedLink(record.path); // bytes now absent/unparseable — drop any stale entry
    return undefined;
  }
  setCachedLink(record.path, record.updatedAt, itemUpdatedAt, link);
  return link;
}

function decodeLinks(records: ItemRecord[]): LinkItem[] {
  return records
    .map((record) => decodeCachedLink(record))
    .filter((link): link is LinkItem => link !== undefined);
}

// The `extractions/` counterpart of decodeCachedLink — same memoized, version-keyed
// decode (decode-cache.ts), so the per-row link↔extraction join is O(changed) too.
function decodeCachedExtraction(record: ItemRecord): ExtractionItem | undefined {
  const itemUpdatedAt = record.itemUpdatedAt ?? 0;
  const cached = getCachedExtraction(record.path, record.updatedAt, itemUpdatedAt);
  if (cached !== undefined) return cached;

  const extraction = decode(record, extractionSchema);
  if (extraction === undefined) {
    dropCachedExtraction(record.path);
    return undefined;
  }
  setCachedExtraction(record.path, record.updatedAt, itemUpdatedAt, extraction);
  return extraction;
}

// The `extractions/{id}.enc` path shadowing a link's `links/{id}.enc` — same `{id}`,
// the writer-split's co-key (entities.ts). Both are id-keyed namespaces, so this is a
// prefix swap.
function extractionPathForLink(linkPath: string): string {
  return rekey(linkPath, LINKS_PREFIX, EXTRACTIONS_PREFIX);
}

// Resolve one link + its (optional) extraction into the display row the UI renders —
// the override-wins join (`customTitle ?? extraction.title`, etc.).
function toView(link: LinkItem, extraction: Extraction | undefined): LinkView {
  return {
    ...link,
    title: link.customTitle ?? extraction?.title,
    imageId: link.customImageId ?? extraction?.imageId,
    pageCopyId: extraction?.pageCopyId,
    screenshotId: extraction?.screenshotId,
  };
}

// The keys the display join ADDS, as a value — the one list `toItem` strips by,
// and the reason `LinkViewFields` is a named type rather than an inline literal.
// Proximity to `toView` would only be a convention; this is a rule the compiler
// keeps: `satisfies` rejects a typo or a key the join doesn't add, and `Record`
// over `keyof LinkViewFields` rejects a MISSING one — so a fifth joined field
// cannot be introduced without the strip learning about it.
const VIEW_FIELDS = {
  title: true,
  imageId: true,
  pageCopyId: true,
  screenshotId: true,
} satisfies Record<keyof LinkViewFields, true>;

// The inverse of toView: drop the four fields the JOIN adds, so a row snapshot can
// go back to the write edge as a stored link. Every UI call site hands a
// `LinkView` to a mutation whose signature says `LinkItem` — the two are
// assignable, so TypeScript cannot catch it — and `links/{id}.enc` must never
// carry an extraction-owned key. Nothing would report it if one did:
// `linkSchema` is a `looseObject`, so an unknown field is PRESERVED (that is what
// lets a newer client's field round-trip through an older one), the projector
// indexes none of these names, and the read edge overwrites all four in `toView`
// — so the junk is invisible locally while being encrypted and pushed to every
// device, and re-spread by every later write of that link. It would also squat on
// names a future `linkSchema` could claim; `title` in particular lived in this
// namespace before the writer-split (docs/link-extraction.md).
//
// Lives HERE, beside `toView`, so the two lists of names cannot drift, and is
// applied at the write edge (mutations.ts writeLink / bulkWriteLinks) rather than
// per caller, so the rule holds for every writer including share-store's.
export function toItem(link: LinkItem): LinkItem {
  const item = { ...link } as Record<string, unknown>;
  for (const field of Object.keys(VIEW_FIELDS)) delete item[field];
  return item as LinkItem;
}

// Batch-join a page of links with their co-keyed extractions (one `bulkGet` by path,
// memoized decode) and resolve each to a display row. The page is small (one virtual
// window), so this is cheap; it's the deliberate cost of keeping `links/` user-only
// (see client-queries.md).
async function joinExtractions(links: LinkItem[]): Promise<LinkView[]> {
  if (links.length === 0) return [];
  const records = await db.items.bulkGet(links.map((link) => extractionPathForLink(link.path)));
  return links.map((link, i) => {
    const record = records[i];
    const extraction = record ? decodeCachedExtraction(record) : undefined;
    return toView(link, extraction);
  });
}

// --- namespace reads (small collections) -------------------------------------

// All records under one namespace prefix, decoded and parse-filtered. The
// `startsWith` runs against the `items` primary key, so it's an index range scan,
// not a full-table walk. Lists/tags are small by design, so reading the whole
// namespace and decoding it is cheap — no index needed.
async function readNamespace<T extends z.ZodTypeAny>(
  prefix: string,
  schema: T,
): Promise<WithPath<z.infer<T>>[]> {
  const records = await db.items.where('path').startsWith(prefix).toArray();
  return records
    .map((record) => decode(record, schema))
    .filter((entity): entity is WithPath<z.infer<T>> => entity !== undefined);
}

// The full logical list set: the user's synced lists merged with the system-list
// defaults (My List / Archive / Trash). Flat — the tree is assembled by the
// caller via `buildTree` (see use-lists), so non-sidebar readers (settings) can
// take the flat set. Tags have no system entries, so `readTags` is a plain read.
//
// Both hand back each entity under its PATH's id, not the copy in its plaintext
// (pathIdentified, shared sync/items.ts) — and for lists BEFORE the merge, since
// the merge is by id: it is what stops a record stored anywhere else from being
// taken for a system list's override, and makes the one stored at a system id
// that override whatever it calls itself. Ids are then unique because paths are,
// which is the property buildTree needs of the set it is given.
export async function readLists(): Promise<ListItem[]> {
  const stored = await readNamespace(LISTS_PREFIX, listSchema);
  return mergeSystemLists(stored.map(pathIdentifiedList));
}

export async function readTags(): Promise<TagItem[]> {
  const stored = await readNamespace(TAGS_PREFIX, tagSchema);
  return stored.map(pathIdentifiedTag);
}

// Every pin (one per pinned link). Small by design — a user pins a handful — so
// the whole namespace is read and decoded, no index, like lists/tags.
export function readPins(): Promise<PinItem[]> {
  return readNamespace(PINS_PREFIX, pinSchema);
}

// The synced general-settings blob (`settings/general.enc`), or undefined if this
// device hasn't synced/written one. A single well-known path (not a namespace), so
// it's a direct `get` + decode rather than a prefix scan. `parseBlob` returns
// undefined for an absent or forward-incompatible blob; callers default each field.
export async function readSettingsGeneral(): Promise<SettingsGeneral | undefined> {
  const record = await db.items.get(SETTINGS_GENERAL_PATH);
  return parseBlob(record?.data, settingsGeneralSchema);
}

// One link looked up by its exact stored URL, or undefined. Served by the
// `itemUrl` index (db.ts): a single keyed lookup, not a `links/` scan that decodes
// every blob until a match — load-bearing because the callers are `useLiveQuery`
// (popup), re-running on every store write. The editor stores the normalized url,
// so callers normalize the query url the same way before querying. Exact match by
// design — this reads back a SPECIFIC stored link (Complete.tsx's live refresh);
// for "is this URL already saved?" use readLinkByUrlKey below. `itemUrl` is
// links-only (projection.ts), so the hit is a link.
export async function readLinkByUrl(url: string): Promise<LinkItem | undefined> {
  const record = await db.items.where('itemUrl').equals(url).first();
  return record ? decodeCachedLink(record) : undefined;
}

// One link that's the SAME RESOURCE as `url` under the canonical dedup identity
// (canonicalUrlKey — folds http/https, `www.`, default port, trailing slash,
// query order, fragment), or undefined — the "is this URL already saved?" check
// behind the extension popup's save flow and the web quick-add's duplicate
// warning. Takes the URL (not a precomputed key) and derives it here, so every
// caller keys identically; served by the `itemUrlKey` index (db.ts), same
// single-keyed-lookup economics as readLinkByUrl. Input the key can't be derived
// from (confirm-saved raw text, canonicalUrlKey → null) falls back to the exact
// lookup, so re-typed raw text still matches its earlier save.
export async function readLinkByUrlKey(url: string): Promise<LinkItem | undefined> {
  const key = canonicalUrlKey(url);
  if (key === null) return readLinkByUrl(url);

  const record = await db.items.where('itemUrlKey').equals(key).first();
  return record ? decodeCachedLink(record) : undefined;
}

// One link by its id (the `{id}` of its `links/{id}.enc`), or undefined — the
// direct-path counterpart of readLinkByUrl, used by the extraction worker to confirm
// the link still exists locally before capturing (it holds a link id from the EXTRACT
// message; active-tab capture reads the live DOM, so it needs existence, not the blob).
export async function readLinkById(linkId: string): Promise<LinkItem | undefined> {
  const record = await db.items.get(pathFromId(linkId, LINKS_PREFIX));
  if (!record) return undefined;
  return decodeCachedLink(record);
}

// N links by path in ONE `bulkGet`, aligned with the input (undefined where the
// path has no local record) — the batched twin of readLinkById, for a bulk action
// that must re-read its selection before writing it (useLinkMutations.destroyMany).
// Same memoized decode, so re-reading rows the view already decoded is free.
export async function readLinksByPaths(paths: string[]): Promise<(LinkItem | undefined)[]> {
  if (paths.length === 0) return [];
  const records = await db.items.bulkGet(paths);
  return records.map((record) => (record ? decodeCachedLink(record) : undefined));
}

// How many links currently belong to `listId`, counted straight off the
// `[itemListId+itemUpdatedAt]` index — an index range count, no blob decode (the
// same column the list views range over). The "is this list empty?" gate for
// deleting a list: a list with links can't be removed (see useListMutations),
// since deleting it would orphan them.
export function countLinksInList(listId: string): Promise<number> {
  return db.items
    .where('[itemListId+itemUpdatedAt]')
    .between([listId, Dexie.minKey], [listId, Dexie.maxKey], true, true)
    .count();
}

// The LOCAL bytes of a `files/{id}.enc` content record, or undefined if absent /
// not yet materialized. Reads straight from the store with NO network and NO crypto:
// `data` holds the already-decrypted blob (an image/screenshot/page copy the extractor
// just wrote, or one a prior sync decrypted). Used by the popup's complete page to
// preview a captured image without round-tripping R2 — the lazy network fetch
// (loadEntityContent) is the sync engine's job, not the UI's.
export async function readFileBytes(fileId: string): Promise<Uint8Array | undefined> {
  const record = await db.items.get(pathFromId(fileId, FILES_PREFIX));
  return record?.data;
}

// --- extraction queries ------------------------------------------------------

// The extraction bookkeeping entity for one link id (the `{id}` of its
// `links/{id}.enc`), or undefined if none has synced/been written yet. A direct
// exact-path read + decode — the path is derived from the id, no scan.
export async function readExtraction(linkId: string): Promise<ExtractionItem | undefined> {
  const record = await db.items.get(pathFromId(linkId, EXTRACTIONS_PREFIX));
  if (!record) return undefined;
  return decodeCachedExtraction(record);
}

// The batched twin of readExtraction — N link ids in one `bulkGet`, aligned with
// the input. Same co-keyed path derivation (`extractions/{id}.enc` shadows
// `links/{id}.enc`), same memoized decode.
export async function readExtractionsByLinkIds(
  linkIds: string[],
): Promise<(ExtractionItem | undefined)[]> {
  if (linkIds.length === 0) return [];
  const records = await db.items.bulkGet(
    linkIds.map((linkId) => pathFromId(linkId, EXTRACTIONS_PREFIX)),
  );
  return records.map((record) => (record ? decodeCachedExtraction(record) : undefined));
}

// The four `titleImage` tallies both counts below are assembled from: the link total
// (an index range-count) and the three recorded outcomes off the `*itemFacetStatuses`
// multiEntry index (projection.ts) — one token per facet, so a status:facet equals-count
// is the exact per-link count, no decode. `pending` can't be counted directly: the
// writer-split makes it ABSENCE (a link with no `done`/`failed`/`permanent` titleImage
// facet — often no extractions file at all — see docs/link-extraction.md), so both
// readers derive it as the link total minus the recorded outcomes. Await-free (a plain
// Promise.all of direct Dexie calls), so awaiting it from a querier costs one native
// resumption — zone-safe without a Promise.resolve wrap (see readLinks' zone-echo note).
function countTitleImageOutcomes(): Promise<[number, number, number, number]> {
  return Promise.all([
    db.items
      .where('[itemType+itemUpdatedAt]')
      .between(['link', Dexie.minKey], ['link', Dexie.maxKey], true, true)
      .count(),
    db.items.where('itemFacetStatuses').equals('done:titleImage').count(),
    db.items.where('itemFacetStatuses').equals('failed:titleImage').count(),
    db.items.where('itemFacetStatuses').equals('permanent:titleImage').count(),
  ]);
}

// The RAW pending-titleImage count: links minus recorded outcomes, four index counts,
// no decode, no join. "Raw" because Trash is NOT folded out — and that's sound for its
// one consumer, extract-all's WAKE SIGNAL (extraction-provider `hasWork`): a trashed
// link's outcome token cancels against its own entry in the link total, so the result
// is exactly livePending + trashedPending — a strict OVER-count of eligible work, never
// an under-count. 0 therefore always means "no live pending links" (safe to stay
// asleep); the rare trashed-pending false positive just runs a finite library walk that
// finds nothing eligible (the walk skips Trash inline) and cleanly ends the job — zero
// paid requests. The exact, trash-corrected tally for DISPLAY is
// readExtractionFacetCounts below; the raw/exact split keeps the O(trash) join off this
// wake path. The cancellation assumes extractions shadow EXISTING links — a dangling
// `extractions/{id}.enc` whose link was destroyed on another device skews every count
// here (its token has no link-total entry to cancel), which is why danglings are a
// deletion problem, not an accounting one: sweepDanglingExtractions removes them
// (bracemark-web fires it once per session, after the first completed sync cycle).
export async function readRawPendingTitleImageCount(): Promise<number> {
  const [totalLinks, done, failedTransient, failedPermanent] = await countTitleImageOutcomes();
  return Math.max(0, totalLinks - done - failedTransient - failedPermanent);
}

// The Settings page's extraction tally, headlined on the `titleImage` facet (the
// primary "fill in title + image" job) — the DISPLAY counterpart of the raw wake count
// above, exact because Trash is folded out.
//
// FOUR buckets, not three, and the fourth is why: `failedTransient` and `permanent` used
// to be summed into one `failed` field rendered under one "Failed" stat, which merged
// "we try this again on the backoff ladder" with "no device will ever try this again".
// That reads as one stuck number — the settled half never moves, so a user who ran
// Generate all saw a by-design outcome as a broken feature, and no sentence could sit
// under the stat without being false for the other half of it. The panes now label them
// `Will retry` / `Won't retry`. Keep them separate here; the fold is the bug.
//
// The two failure buckets are named as a PAIR — `failedTransient` / `failedPermanent` —
// and neither spelling is the schema's. `ExtractVerdict` (shared extract/retry.ts) is
// `'failed' | 'permanent'`, so a faithful copy would reuse the bare `failed` that caused
// this bug and would leave the pair reading as two unrelated things. These are DISPLAY
// buckets; the mapping is `failed` → `failedTransient`, `permanent` → `failedPermanent`,
// applied to both so the vocabulary is consistent rather than half-borrowed. The old
// `failed` field is GONE rather than narrowed, which is the other half of the same idea —
// a consumer that still reads `.failed` should fail to compile, not quietly under-count by
// the permanent share.
//
// `pending` keeps its exact meaning: links with NO facet at all, which is precisely the
// set the drains will pick up right now. That is load-bearing beyond display — both panes
// gate "Generate all" on `pending === 0` and print it in the confirm line — so a cooling
// `failedTransient` link must NOT be folded in here, however much it reads like pending
// work to a user. Doing so would enable a button that drains nothing (the drains skip
// still-cooling links; see readLinksPendingTitleImagePage), which is the same failure the
// trash exclusion below exists to prevent.
//
// TRASHED links are excluded from all four, matching the drains (which skip them — see
// readLinksPendingTitleImagePage): a trashed pending link is work the drains will never
// do, so counting it would show a Pending stat that never drops and a "Generate all"
// button that drains nothing. Exactness costs the O(trash) link↔extraction join below,
// which is why this read is mounted ON DEMAND (useExtractionCounts — only while a
// surface renders the numbers) and never rides the always-on wake path.
export interface ExtractionFacetCounts {
  done: number;
  pending: number;
  // A transient failure, cooling off — retried once past `backoff(attempts)`, forever
  // (the curve caps at a day, it never gives up). A 403 climbs this ladder and converts
  // itself to the bucket below when it tops out, so links migrate out of here on their own.
  failedTransient: number;
  // Settled without a result: 404/410/451, the auth walls, a non-HTML content type, an
  // empty body, a topped-out 403. Never eligible again on ANY device, because the verdict
  // is synced. This is the only bucket that never drains on its own — trashing a link
  // still drops it, since every term below subtracts its trashed share.
  failedPermanent: number;
}

// The trash correction for the tally: how many TRASHED links sit in each bucket, so each
// term below can be reduced by it. This can't be an index count like the rest, because the
// two terms disagree about where list membership lives — `itemListId` is projected on
// LINKS only (projection.ts keeps that exclusive on purpose), while the `done`/`failed`
// tokens live on the co-keyed EXTRACTION record, which carries no list. So it's a join:
// walk the trash list, read each link's extraction, tally its titleImage status. Absence
// counts as pending, exactly as the tally above defines it.
//
// The trash side is read as `primaryKeys()`, NOT `toArray()`: the only things wanted from
// a trashed LINK are its path (to derive the co-keyed extraction path) and the row count,
// and `path` IS the primary key — so the key-only read gets both while leaving every
// trashed link's encrypted blob on disk. `toArray()` would materialize the whole of Trash
// into memory on every re-run to look at one string per record. Only the EXTRACTION side
// needs full records, since it's the one being decoded.
//
// O(trash) reads per re-run. This rides the ON-DEMAND counts liveQuery
// (useExtractionCounts), so it repeats per `db.items` transaction only while a surface
// showing the numbers is mounted — never on the always-on wake path (the raw count
// above). It's the cheaper of the two joins available — the other direction (every
// settled extraction back to its link) is O(library) — and decoding is memoized, but a
// huge Trash makes it real work. Emptying Trash makes it free.
async function readTrashedTitleImageCounts(): Promise<{
  total: number;
  done: number;
  failedTransient: number;
  failedPermanent: number;
}> {
  const paths = await db.items
    .where('[itemListId+itemUpdatedAt]')
    .between([TRASH_ID, Dexie.minKey], [TRASH_ID, Dexie.maxKey], true, true)
    .primaryKeys();
  if (paths.length === 0) return { total: 0, done: 0, failedTransient: 0, failedPermanent: 0 };

  const exRecords = await db.items.bulkGet(paths.map((path) => extractionPathForLink(path)));
  let done = 0;
  let failedTransient = 0;
  let failedPermanent = 0;
  for (const exRecord of exRecords) {
    const status = exRecord
      ? decodeCachedExtraction(exRecord)?.facets.titleImage?.status
      : undefined;
    // One bucket per status, matching the tally's own — the two failure kinds are counted
    // apart here for the same reason they are rendered apart.
    if (status === 'done') done += 1;
    else if (status === 'failed') failedTransient += 1;
    else if (status === 'permanent') failedPermanent += 1;
  }
  return { total: paths.length, done, failedTransient, failedPermanent };
}

export async function readExtractionFacetCounts(): Promise<ExtractionFacetCounts> {
  // Promise.resolve: helper await inside a querier (this feeds a liveQuery) — see
  // readLinks' zone-echo note. countTitleImageOutcomes is await-free (a Promise.all of
  // direct Dexie calls), so it's safe as-is; only the stacked-await helper needs the wrap.
  const trashed = await Promise.resolve(readTrashedTitleImageCounts());
  const [totalLinks, done, failedTransient, failedPermanent] = await countTitleImageOutcomes();
  // Each term drops its trashed share, so the four still sum to the live link total — the
  // Settings stats render that sum as the total, so a bucket that didn't subtract its own
  // trash would inflate the denominator of "N of M links previewed".
  const liveLinks = totalLinks - trashed.total;
  const liveDone = done - trashed.done;
  const liveFailedTransient = failedTransient - trashed.failedTransient;
  const liveFailedPermanent = failedPermanent - trashed.failedPermanent;
  return {
    done: liveDone,
    failedTransient: liveFailedTransient,
    failedPermanent: liveFailedPermanent,
    pending: Math.max(0, liveLinks - liveDone - liveFailedTransient - liveFailedPermanent),
  };
}

// A position in the newest-first `links/` walk, used to PAGINATE the whole-library
// extract-all drain (extraction-provider) without re-scanning from the top each batch. It
// names the last link the walk EXAMINED — `(createdAt, path)` — so the next page resumes
// strictly past it. `path` is the tiebreak, not decoration: the `[itemType+itemCreatedAt]`
// index orders equal-createdAt rows by primary key (path), and a bulk import can stamp many
// links the same millisecond (writeLink uses `Date.now()`), so createdAt alone can't pin a
// resume point — a page boundary mid-collision would skip or repeat links.
export interface LinkScanCursor {
  createdAt: number;
  path: string;
}

// One page of the extract-all walk: up to `limit` pending+eligible links (newest-first), plus
// the `cursor` to resume from. `cursor === null` means the library is exhausted (the drain
// stops); a non-null cursor always pairs with a FULL `links` page (the scan only stops early
// when it hits `limit`), so the caller keeps paging while it's non-null.
export interface PendingTitleImagePage {
  links: LinkItem[];
  cursor: LinkScanCursor | null;
}

// How many `links/` records one inner scan step pulls while hunting for the page's `limit`
// eligible links. Bounds memory per step; a settled-heavy stretch just costs more steps —
// but each link is still examined at most ONCE across the whole drain, because the cursor
// only moves forward (the property that makes extract-all O(library), not O(library²)).
const SCAN_CHUNK = 200;

function toCursor(record: ItemRecord): LinkScanCursor {
  return { createdAt: record.itemCreatedAt ?? 0, path: record.path };
}

// The residual extraction queue for the WHOLE-LIBRARY "extract all" job (extraction-provider
// `extractAll`), as a QUERY (there's no queue object — see docs/link-extraction.md "the queue
// is a query"), PAGINATED. Returns up to `limit` links whose `titleImage` is pending+eligible,
// newest-first, plus a `cursor` the caller threads back to resume. The automatic drain uses
// the displayed-scoped read below instead.
//
// TRASHED links are skipped: they're excluded from every browse and search view (use-links),
// so extracting one spends a paid request filling in a title the user can only see by
// restoring the link first. "Whole-library" means the library you can actually see.
//
// Cost: O(examined), and across a full drain O(library) total — NOT the O(settled)-per-batch
// of a blocked-set rebuild, and NOT the O(library²) of re-scanning from the top every batch.
// The forward `cursor` is what buys that: each batch resumes where the last left off, so a
// just-extracted link is behind the cursor and never re-walked. Eligibility is tested INLINE
// off each link's own co-keyed extraction facet (`isFacetEligible`, like the
// displayed-scoped read) rather than against a precomputed blocked set — so the test stays
// FRESH: a link a concurrent sync settled mid-drain drops out here instead of costing a
// redundant (paid) extract. Missing / settled / still-cooling links are skipped; only their
// position advances the cursor.
export async function readLinksPendingTitleImagePage(
  now: number,
  limit: number,
  cursor?: LinkScanCursor,
): Promise<PendingTitleImagePage> {
  if (limit <= 0) return { links: [], cursor: cursor ?? null };

  const pending: ItemRecord[] = [];
  // The window already consumed: rows at `scannedFrom.createdAt` with `path >= scannedFrom.path`
  // were examined on a prior page/step, so skip them. Undefined = start at the newest link.
  let scannedFrom = cursor;
  let scannedTo: LinkScanCursor | null = cursor ?? null;

  for (;;) {
    const upper = scannedFrom ? scannedFrom.createdAt : Dexie.maxKey;
    const chunk = await db.items
      .where('[itemType+itemCreatedAt]')
      .between(['link', Dexie.minKey], ['link', upper], true, true)
      .reverse()
      .limit(SCAN_CHUNK)
      .toArray();
    if (chunk.length === 0) return { links: decodeLinks(pending), cursor: null };

    // Co-keyed extractions for the chunk, fetched once — the join the inline eligibility
    // test reads (the writer-split's `extractions/{id}` shadow of each `links/{id}`).
    const exRecords = await db.items.bulkGet(chunk.map((r) => extractionPathForLink(r.path)));

    let examined = 0;
    for (let i = 0; i < chunk.length; i++) {
      const record = chunk[i];
      const createdAt = record.itemCreatedAt ?? 0;
      // Skip the prior window's already-examined rows (same createdAt, path at/after it).
      if (scannedFrom && createdAt === scannedFrom.createdAt && record.path >= scannedFrom.path)
        continue;
      examined++;
      scannedTo = { createdAt, path: record.path };

      // No extraction work for trashed links. Skipped AFTER the cursor advances over
      // them, so the walk still makes progress and never re-examines them.
      if (record.itemListId === TRASH_ID) continue;

      const exRecord = exRecords[i];
      const facet = exRecord ? decodeCachedExtraction(exRecord)?.facets.titleImage : undefined;
      if (isFacetEligible(facet, now)) {
        pending.push(record);
        if (pending.length >= limit) return { links: decodeLinks(pending), cursor: scannedTo };
      }
    }

    // A short chunk means we reached the oldest link — library exhausted.
    if (chunk.length < SCAN_CHUNK) return { links: decodeLinks(pending), cursor: null };

    // Advance into the next chunk. Normally `scannedTo` (the last examined row) is the chunk's
    // last row, so the window moves forward. If `examined === 0` the whole full chunk was
    // the skipped boundary run (a collision run longer than SCAN_CHUNK sharing one
    // createdAt) — `scannedTo` didn't move, so step `scannedFrom` to the chunk's last row to
    // force progress through the run.
    scannedFrom = examined === 0 ? toCursor(chunk[chunk.length - 1]) : (scannedTo ?? undefined);
  }
}

// The pending-titleImage subset of a SPECIFIC set of link paths, in the given order — the
// read behind bracemark-web's displayed-driven AUTOMATIC extraction (extraction-provider). Where
// `readLinksPendingTitleImagePage` walks the whole library for the conscious "extract all" job,
// this scopes the automatic drain to what the user is actually looking at: the page of links
// the main pane has rendered. So a 30k-link bulk import left in an abandoned tab never
// extracts past what was scrolled into view — work tracks attention, not an arbitrary cap.
//
// Cost: O(displayed), NOT O(library) — load-bearing because this read backs the always-on
// probe liveQuery (extraction-provider), which re-runs on every `db.items` write. Two
// `bulkGet`s of the given paths (the links + their co-keyed extractions), then an inline
// per-path eligibility test (`isFacetEligible`) — the same direct facet test the
// extract-all page read uses, just over a bounded path set. Order follows `linkPaths` (the
// display order — newest first), so on-screen links extract top-down. Missing / non-link /
// trashed / settled / still-cooling paths drop out.
//
// Trashed paths drop out because the drains give Trash no extraction work at all (see the
// extract-all read above). The layouts report whatever rows they render, and the Trash view
// renders trashed links like any other — so browsing Trash must not become the one way to
// spend paid requests on links the user removed. Filtering here rather than asking each
// caller not to report keeps that policy at the read layer, where the extract-all walk
// already enforces it.
export async function readLinksPendingTitleImageForLinkPaths(
  linkPaths: string[],
  now: number,
): Promise<LinkItem[]> {
  if (linkPaths.length === 0) return [];

  const [records, exRecords] = await Promise.all([
    db.items.bulkGet(linkPaths),
    db.items.bulkGet(linkPaths.map(extractionPathForLink)),
  ]);

  const pending: ItemRecord[] = [];
  for (let i = 0; i < linkPaths.length; i++) {
    const record = records[i];
    if (!record || record.itemType !== 'link' || record.itemListId === TRASH_ID) continue;

    const exRecord = exRecords[i];
    const facet = exRecord ? decodeCachedExtraction(exRecord)?.facets.titleImage : undefined;
    if (isFacetEligible(facet, now)) pending.push(record);
  }
  return decodeLinks(pending);
}

// --- link query --------------------------------------------------------------

function clauseEmpty(c: Clause): boolean {
  return c.any.length === 0 && c.all.length === 0 && c.none.length === 0;
}

function hasTextClause(q: LinkQuery): boolean {
  return (
    !clauseEmpty(q.url) || !clauseEmpty(q.title) || !clauseEmpty(q.text) || !clauseEmpty(q.note)
  );
}

// Predicates the indexed COLUMNS can answer without decoding the blob — list id
// and tag ids (db.ts). The driver index pre-narrows for one positive clause;
// this re-checks every clause so it's correct no matter which (or no) driver ran.
function columnMatches(record: ItemRecord, q: LinkQuery): boolean {
  const listId = record.itemListId;
  if (q.lists.any.length > 0 && (listId === undefined || !q.lists.any.includes(listId))) {
    return false;
  }
  if (q.lists.none.length > 0 && listId !== undefined && q.lists.none.includes(listId)) {
    return false;
  }
  const tagIds = record.itemTagIds ?? [];
  if (q.tags.any.length > 0 && !q.tags.any.some((t) => tagIds.includes(t))) return false;
  if (q.tags.all.length > 0 && !q.tags.all.every((t) => tagIds.includes(t))) return false;
  if (q.tags.none.length > 0 && q.tags.none.some((t) => tagIds.includes(t))) return false;
  return true;
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

// A query needs the link↔extraction JOIN when it filters on the resolved title: the
// `title` clause (field-scoped) or the `text` clause (whose haystack includes the
// title). Both read `extraction.title`, which lives in `extractions/`, so neither can
// run in the sync walk — they force the join and drop the exact count.
function needsExtractionJoin(q: LinkQuery): boolean {
  return !clauseEmpty(q.title) || !clauseEmpty(q.text);
}

// The URL text predicate — on the decoded LINK (url lives in `links/`), so it can run
// inside the sync filter walk. Never index-served (text is in the blob): a JS post-filter
// (the "scan for now" choice; the scalable upgrade is a write-time `*itemSearchWords`
// token index).
function urlMatches(link: LinkItem, q: LinkQuery): boolean {
  return wordsMatch(link.url, q.url);
}

// The note predicate — like `url`, it reads the decoded LINK (`link.note` lives in
// `links/{id}.enc`), so it runs in the sync filter walk and never forces the
// extraction join. An absent note is an empty haystack: an `any`/`all` term fails,
// a `none`-only term passes — the same rule `titleMatches` follows.
function noteMatches(link: LinkItem, q: LinkQuery): boolean {
  return wordsMatch(link.note ?? '', q.note);
}

// Both link-blob predicates in one call — the half of a text filter that needs
// nothing but the link. Every site that used to call `urlMatches` alone calls
// this, so adding a link-scoped field never means auditing the call sites again.
function linkFieldsMatch(link: LinkItem, q: LinkQuery): boolean {
  return urlMatches(link, q) && noteMatches(link, q);
}

// The title text predicate — on the RESOLVED display title (`customTitle ?? extraction.title`).
// `customTitle` is on the link, but `extraction.title` lives in the co-keyed
// `extractions/{id}.enc`, so a title clause forces the link↔extraction JOIN; it can't run
// in the sync walk. An empty haystack is fine: an `any` term fails (nothing to match), a
// `none`-only term passes (nothing excluded).
function titleMatches(link: LinkItem, extraction: Extraction | undefined, q: LinkQuery): boolean {
  return wordsMatch(link.customTitle ?? extraction?.title ?? '', q.title);
}

// The BASIC-search predicate — words matched against the combined url⊕title haystack
// (host is already inside url), so a word may match in either half. Needs the
// extraction join for the title half, like `titleMatches`; an empty title half is
// fine (wordsMatch passes a `none`-only clause and fails an `any`/`all` one).
function textMatches(link: LinkItem, extraction: Extraction | undefined, q: LinkQuery): boolean {
  const title = link.customTitle ?? extraction?.title ?? '';
  return wordsMatch(`${link.url} ${title}`, q.text);
}

// The compound index + record column backing each sort dimension. Both
// timestamps are projected on every type (projection.ts), so each sort reuses the
// same two link indexes; only the ordering component differs.
const SORT_INDEXES: Record<
  LinkSortOn,
  { type: string; list: string; column: 'itemUpdatedAt' | 'itemCreatedAt' }
> = {
  updatedAt: {
    type: '[itemType+itemUpdatedAt]',
    list: '[itemListId+itemUpdatedAt]',
    column: 'itemUpdatedAt',
  },
  createdAt: {
    type: '[itemType+itemCreatedAt]',
    list: '[itemListId+itemCreatedAt]',
    column: 'itemCreatedAt',
  },
};

// A browse view with a single positive list/all clause and nothing else: walk one
// compound index in order, materialize only the page, and count via the index —
// no decode of the whole library, exact total. `exclude` drops the pinned links
// already surfaced by the overlay; every one of them falls in THIS range (it
// matched the same query), so the rest-count is exactly `total - exclude.size`.
// The index is ascending by nature; `desc` (newest first) walks it reversed.
async function rangeFastPath(
  index: string,
  key: string,
  limit: number,
  exclude: Set<string>,
  desc: boolean,
): Promise<RestResult> {
  const range = db.items.where(index).between([key, Dexie.minKey], [key, Dexie.maxKey], true, true);
  const ordered = range.clone();
  const [records, total] = await Promise.all([
    (desc ? ordered.reverse() : ordered)
      .filter((record) => !exclude.has(record.path))
      .limit(limit)
      .toArray(),
    range.count(),
  ]);
  const restTotal = total - exclude.size;
  return { links: decodeLinks(records), total: restTotal, hasMore: restTotal > limit };
}

// Finish a query from an already-loaded candidate subset (the tag-driven path):
// drop non-matches on the columns (no decode), sort by the chosen sort column
// (still no decode — it's an indexed column), then decode only as far as the page
// needs. Exact total when there's no text clause (the column survivors ARE the
// match set); undefined once text filtering applies.
async function finishFromCandidates(
  candidates: ItemRecord[],
  q: LinkQuery,
  limit: number,
  exclude: Set<string>,
): Promise<RestResult> {
  const { column } = SORT_INDEXES[q.sortOn];
  const desc = q.sortOrder === 'desc';
  const survivors = candidates.filter((r) => !exclude.has(r.path) && columnMatches(r, q));
  survivors.sort((a, b) => {
    const av = a[column] ?? 0;
    const bv = b[column] ?? 0;
    return desc ? bv - av : av - bv;
  });

  if (!hasTextClause(q)) {
    return {
      links: decodeLinks(survivors.slice(0, limit)),
      total: survivors.length,
      hasMore: survivors.length > limit,
    };
  }

  if (needsExtractionJoin(q)) return finishWithExtractionSearch(survivors, q, limit);

  // url/note-only text: filter on the decoded link, no extraction join needed.
  const links: LinkItem[] = [];
  for (const record of survivors) {
    const link = decodeCachedLink(record);
    if (link && linkFieldsMatch(link, q)) {
      links.push(link);
      if (links.length > limit) break; // one past the page → hasMore
    }
  }
  return { links: links.slice(0, limit), total: undefined, hasMore: links.length > limit };
}

// Finish an EXTRACTION-dependent search page (a `title` and/or `text` clause). The
// resolved title lives in `extractions/`, so it can't be filtered in the sync walk:
// take the column-filtered survivor records (already in sort order), apply the link-blob
// clauses (url, note) on the decoded link, bulk-join their extractions, then apply the
// title + text clauses and page. Materializes the survivor set — this search is already non-exact /
// a scan — so the cost is bounded by the column+url survivors (the whole library only
// for a bare title/text search, plus the extraction reads).
async function finishWithExtractionSearch(
  survivors: ItemRecord[],
  q: LinkQuery,
  limit: number,
): Promise<RestResult> {
  const urlPassed: LinkItem[] = [];
  for (const record of survivors) {
    const link = decodeCachedLink(record);
    if (link && linkFieldsMatch(link, q)) urlPassed.push(link);
  }
  const exRecords = await db.items.bulkGet(urlPassed.map((l) => extractionPathForLink(l.path)));
  const links: LinkItem[] = [];
  for (let i = 0; i < urlPassed.length; i++) {
    const exRecord = exRecords[i];
    const extraction = exRecord ? decodeCachedExtraction(exRecord) : undefined;
    if (titleMatches(urlPassed[i], extraction, q) && textMatches(urlPassed[i], extraction, q)) {
      links.push(urlPassed[i]);
      if (links.length > limit) break; // one past the page → hasMore
    }
  }
  return { links: links.slice(0, limit), total: undefined, hasMore: links.length > limit };
}

// The page of NON-pinned links — the driver result before the pinned overlay is
// prepended (so no `pinnedCount` yet) and before `readLinks` stamps the page
// identity (`query`/`limit`). Pinned links are excluded via `exclude`. Carries plain
// `LinkItem`s (not display-resolved `LinkView`s) — the extraction join is deferred to
// readLinks, which joins the whole page (overlay + rest) in one pass.
interface RestResult {
  links: LinkItem[];
  total?: number;
  hasMore: boolean;
}

// One page of the link library for `query` MINUS `exclude`, ordered by
// `query.sortOn`/`query.sortOrder` (default: newest-modified first). Picks the
// cheapest driver for the clauses present:
//   - single list / no filters → index-ordered fast path (exact count).
//   - positive tag clause → drive the selective `*itemTagIds` index, finish over
//     that subset (a tag's links, never the whole library), sorted in JS.
//   - anything else (multi-list, `none`, text) → walk the all-links ordered index
//     applying every clause and decoding lazily, stopping at the page; total is
//     non-exact.
async function readRest(
  query: LinkQuery,
  limit: number,
  exclude: Set<string>,
): Promise<RestResult> {
  const index = SORT_INDEXES[query.sortOn];
  const desc = query.sortOrder === 'desc';
  // The `[..+itemUpdatedAt|itemCreatedAt]` index is ascending; `desc` reverses the
  // walk. Applied to every ordered scan below so all drivers honor the direction.
  const linkRange = () => {
    const range = db.items
      .where(index.type)
      .between(['link', Dexie.minKey], ['link', Dexie.maxKey], true, true);
    return desc ? range.reverse() : range;
  };
  const onlyLists =
    clauseEmpty(query.tags) &&
    clauseEmpty(query.url) &&
    clauseEmpty(query.title) &&
    clauseEmpty(query.text) &&
    clauseEmpty(query.note);

  if (onlyLists && query.lists.none.length === 0) {
    if (query.lists.any.length === 1) {
      return rangeFastPath(index.list, query.lists.any[0], limit, exclude, desc);
    }
    if (query.lists.any.length === 0) {
      return rangeFastPath(index.type, 'link', limit, exclude, desc);
    }
  }

  // Most selective positive clause is a tag: drive the tag index. `any` is an OR
  // membership (`anyOf`, deduped); for an `all`-only query we drive on the first
  // tag and let `columnMatches` enforce the rest.
  const tagDriver = query.tags.any.length > 0 ? query.tags.any : query.tags.all.slice(0, 1);
  if (tagDriver.length > 0) {
    const candidates = await db.items.where('itemTagIds').anyOf(tagDriver).distinct().toArray();
    return finishFromCandidates(candidates, query, limit, exclude);
  }

  // A title/text clause can't be filtered in the sync walk (the resolved title lives in
  // `extractions/`): gather every column-filtered survivor in sort order, then join +
  // filter + page.
  if (needsExtractionJoin(query)) {
    const survivors = await linkRange()
      .filter((record) => !exclude.has(record.path) && columnMatches(record, query))
      .toArray();
    return finishWithExtractionSearch(survivors, query, limit);
  }

  // No positive tag clause and no title/text clause: walk all links in sort order, filtering
  // as we go on columns + url/note (decoded link). The `filter` stops once `limit + 1` pass
  // (one past the page detects `hasMore`), so it touches a bounded slice, not the library.
  const records = await linkRange()
    .filter((record) => {
      if (exclude.has(record.path) || !columnMatches(record, query)) return false;
      const link = decodeCachedLink(record);
      return link !== undefined && linkFieldsMatch(link, query);
    })
    .limit(limit + 1)
    .toArray();

  return {
    links: decodeLinks(records).slice(0, limit),
    total: undefined,
    hasMore: records.length > limit,
  };
}

// The pinned links that MATCH `query`, in pin-rank order — the overlay floated to
// the top of every view a pinned link appears in. Reads the small `pins/`
// namespace, looks up each pin's `links/{id}.enc` record (bulkGet preserves the
// rank order of the keys), and keeps only those that exist and pass the same
// column + text predicates the rest of the query uses. A pin whose link is gone
// or doesn't match the active view is simply skipped. Returns the decoded links
// and the set of their paths, so `readRest` can exclude them and not double-show.
async function readPinnedOverlay(
  query: LinkQuery,
): Promise<{ links: LinkItem[]; paths: Set<string> }> {
  // Promise.resolve: helper await inside a querier — see readLinks' zone-echo note.
  const pins = (await Promise.resolve(readPins())).sort(compareRank);
  if (pins.length === 0) return { links: [], paths: new Set() };

  const records = await db.items.bulkGet(pins.map((pin) => pathFromId(pin.id, LINKS_PREFIX)));
  const hasLinkFields = !clauseEmpty(query.url) || !clauseEmpty(query.note);
  const passed: LinkItem[] = [];
  for (const record of records) {
    if (!record || !columnMatches(record, query)) continue;
    const link = decodeCachedLink(record);
    if (!link || (hasLinkFields && !linkFieldsMatch(link, query))) continue;
    passed.push(link);
  }

  if (!needsExtractionJoin(query)) {
    return { links: passed, paths: new Set(passed.map((l) => l.path)) };
  }

  // Title/text clause: join each pinned link's extraction (pins are few) and apply the filter.
  const exRecords = await db.items.bulkGet(passed.map((l) => extractionPathForLink(l.path)));
  const links: LinkItem[] = [];
  passed.forEach((link, i) => {
    const exRecord = exRecords[i];
    const extraction = exRecord ? decodeCachedExtraction(exRecord) : undefined;
    if (titleMatches(link, extraction, query) && textMatches(link, extraction, query)) {
      links.push(link);
    }
  });
  return { links, paths: new Set(links.map((l) => l.path)) };
}

// One page for `query`: the pinned matching links first (rank order, always whole),
// then the page of the rest. `limit`/"show more" pages only the rest — pins are
// few and never paginated. The pinned set is excluded from the rest so a link
// never appears twice, and folded into `total` when the rest's total is exact.
//
// ZONE-ECHO CONSTRAINT (this is a liveQuery querier — useLinks). Dexie tracks
// which ranges a querier read via a zone it keeps alive across awaits, but the
// zone survives only ONE native-await resumption per awaited Dexie promise:
// awaiting an async HELPER that itself awaited (a stacked resumption) silently
// kills it, and every Dexie call after that registers nothing — the query still
// returns correct data, but writes never re-fire it (new links didn't appear
// until a reload; pin writes still re-fired because `pins/` was read before the
// zone died, which masked the bug). Inside the zone the global `Promise` is
// Dexie's own, so `await Promise.resolve(helper())` re-arms the echo — the wrap
// Dexie's docs prescribe for foreign promises (https://dexie.org/docs/liveQuery()).
// The invariant for everything reachable from a querier: direct `db.*` awaits,
// pass-through `return helper()`, and `Promise.all` of direct Dexie calls are
// safe; an AWAIT of an async helper must be wrapped in `Promise.resolve(...)`.
// Verified in-browser (Chrome + dexie 4.4.3, 2026-07); Node/fake-indexeddb
// resolves in microtasks and never reproduces it, so tests won't catch a
// regression here.
export async function readLinks(query: LinkQuery, limit: number): Promise<LinksResult> {
  const overlay = await Promise.resolve(readPinnedOverlay(query));
  const rest = await Promise.resolve(readRest(query, limit, overlay.paths));
  // Join the whole page (overlay + rest) with extractions in one pass → display rows.
  const links = await Promise.resolve(joinExtractions([...overlay.links, ...rest.links]));
  return {
    links,
    pinnedCount: overlay.links.length,
    total: rest.total === undefined ? undefined : overlay.links.length + rest.total,
    hasMore: rest.hasMore,
    query,
    limit,
  };
}
