// The share-sheet data seam — everything the share surface (docs/share-sheet.md)
// exchanges with the rest of the app. The process split drives the design:
//
//  - ANDROID's share activity runs in the app's own process, so it reads the
//    taxonomy live from sqlite and saves through the real write edge
//    (mutations.ts) — the pending op then rides the normal sync drain. What it
//    cannot do from there is fetch the page: that is the main app's
//    ExtractionProvider, which the share activity does not mount. So each save
//    leaves a HANDOFF marker the main app collects (_the Android handoff_,
//    below).
//  - iOS's share extension is a SEPARATE process that must not open the app's
//    sqlite (a shared-container file lock invites the 0xdead10cc kill), so it
//    exchanges atomic per-item JSON files in the App Group container instead:
//    it READS a taxonomy snapshot the main app maintains, and WRITES one
//    outbox draft per Add that the main app drains through the same write edge
//    on the next launch/foreground.
//
// Drafts are idempotent by construction: the link id (and any new list's/tag's
// id AND rank) is minted in the sheet and travels with the draft everywhere, so
// a retried drain (crash between the local write and the file delete) and the
// extension's best-effort upload re-write the SAME entities instead of
// duplicating or shuffling. Minting the rank against the sheet's taxonomy
// (live on Android, snapshot on iOS) is safe because a stale-snapshot rank can
// only TIE with a rank minted elsewhere since — the same equal-key case two
// devices inserting concurrently already produce, broken deterministically by
// id in the sort (shared sync/rank.ts), never data loss.
//
// The schemas below carry NO back-compat slack — rank is required wherever it
// appears (no drain-side fallback, no upload-side skip) and `newLists` has no
// `.default([])`. Each of those covered files written by a build predating the
// field, and nothing has shipped, so no such file can exist; the greenfield
// rule is to tighten the schema in place rather than carry compatibility with a
// past that never happened. A payload missing either is therefore corrupt, and
// the parse boundary rejects it like any other malformed input. Both are worth
// revisiting the day a build ships: an outbox draft or snapshot CAN outlive an
// app update, which is the skew these once guarded.
//
// Everything that lands in the App Group container is PLAINTEXT BY DESIGN —
// the same trust boundary as the rest of the device store (bracemark-expo keeps
// content decrypted on device; see architecture.md). clearShareData() is part
// of the sign-out teardown (clear-data.ts) so none of it outlives the session.

import { Platform } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

import {
  type ApiClient,
  buildTree,
  cleanTitle,
  compareRank,
  DEFAULT_LIST_ID,
  entitlementsOf,
  flattenTree,
  LINKS_PREFIX,
  type List,
  LIST_NO_CHILDREN_IDS,
  LISTS_PREFIX,
  pathFromId,
  type Tag,
  TAGS_PREFIX,
  TRASH_ID,
  z,
} from '@stxapps/shared';

import { appGroupDir } from './app-group';
import { getSession, loadSession, loadSharedSession } from './session-store';

// THE STORE HALF OF THIS MODULE IS LAZY, and that is a memory rule, not a style
// choice. This file is on the iOS share extension's critical path, where
// everything the entry transitively imports is executed on every cold share
// (docs/share-sheet.md, _keep index.share.js lean_) — and the extension is the
// one caller that needs NONE of it: sqlite, the write edge and the sync engine
// belong to the Android activity (same process as the app) and to the main
// app's drain. Statically imported, they put drizzle-orm + expo-sqlite + the
// engine into the extension's init for nothing; behind these accessors they
// stay out of the cold path and cost a cached module lookup on the platform
// that does use them. `typeof import(...)` keeps every call site fully typed,
// and Metro resolves the literal specifier at build time, so the graph is
// unchanged — only WHEN each module is evaluated.
//
// The same reasoning covers `share-upload` (iOS, but only after Save — it drags
// the whole quick-crypto stack) and `newId` in @stxapps/expo-crypto's lib/ids.
// Keep them lazy; a static import here is silent, and only a cold share on a
// device shows the cost.
const engine = (): typeof import('../sync/engine') => require('../sync/engine');
const itemStore = (): typeof import('./item-store') => require('./item-store');
const mutations = (): typeof import('./mutations') => require('./mutations');
const queries = (): typeof import('./queries') => require('./queries');
const reviewPrompts = (): typeof import('./review-prompt-store') =>
  require('./review-prompt-store');
const shareUpload = (): typeof import('./share-upload') => require('./share-upload');
const subscriptions = (): typeof import('./subscription-store') => require('./subscription-store');

// --- shapes -------------------------------------------------------------------

// A list/tag the sheet minted for creation at apply time. `rank` is minted in
// the sheet too (from the taxonomy's neighbour ranks — see the header on why a
// stale rank is only a tie), so the upload and the drain write identical
// entities from the draft alone. Required: the sheet mints against the taxonomy
// it already renders its pickers from, so a rank-free entry can only be corrupt.
const shareNewEntitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rank: z.string().min(1),
});
export type ShareNewEntity = z.infer<typeof shareNewEntitySchema>;

// One Add, as minted by the sheet. `tagIds` is the link's FINAL tag order and
// already includes the ids in `newTags` (which just says which of those must be
// created). `newLists` is the list counterpart — at most one in practice (the
// sheet's create-and-select), `parentId` pinned null at apply (the editors'
// top-level-only create rule — docs/editors.md). It carries no `.default([])`,
// for the same reason `rank` above is required: the default only ever covered
// drafts from a build predating the field, and no such build shipped. `title`
// is the share payload's page title — it seeds the provisional
// `extraction.title` at apply time, never `customTitle` (the same
// not-a-deliberate-user-title rule as bulk import — shared entities.ts).
const shareDraftSchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  title: z.string().optional(),
  listId: z.string().min(1),
  tagIds: z.array(z.string()),
  newTags: z.array(shareNewEntitySchema),
  newLists: z.array(shareNewEntitySchema),
  sharedAt: z.number().int(),
});
export type ShareDraft = z.infer<typeof shareDraftSchema>;

// What the sheet's pickers render, plus what its link-cap gate decides on.
// Lists arrive flattened in tree order with their indentation `depth` (the sheet
// has no tree logic); tags in rank order. `rank` rides along so the sheet can
// mint the neighbour rank for what it creates — index 0 for both entities
// (docs/editors.md). Required: the snapshot is rewritten from the store by
// refreshShareTaxonomy, which always has ranks, so a rank-free row means a
// corrupt file — and reading THAT as signed-out is the right answer, since it
// points the user at the app, which rewrites it.
//
// `linkCount` + `maxLinks` are the cap gate's inputs, and they are here because
// the iOS extension can reach NEITHER at first hand: the count lives in the
// sqlite it must not open, and the cached plan lives in that same database
// (data/subscription-store.ts reads it through getDb()). Carrying both on the
// snapshot is what lets iOS refuse at the cap like every other create surface —
// the free tier's 200-link wall is client-enforced now,
// so the server no longer backstops a share that slips through. See isAtLinkCap.
const shareTaxonomySchema = z.object({
  sessionPresent: z.boolean(),
  lists: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      depth: z.number().int(),
      rank: z.string(),
    }),
  ),
  tags: z.array(z.object({ id: z.string(), name: z.string(), rank: z.string() })),
  // Links in the store, counted the server's trash-INCLUSIVE way (countLinks).
  linkCount: z.number().int(),
  // The cached plan's cap; null = unlimited OR unknown, and both fail OPEN.
  maxLinks: z.number().int().nullable(),
});
export type ShareTaxonomy = z.infer<typeof shareTaxonomySchema>;
export type ShareTaxonomyList = ShareTaxonomy['lists'][number];
export type ShareTaxonomyTag = ShareTaxonomy['tags'][number];

// A signed-out / snapshot-missing taxonomy — what the sheet shows its "open
// Bracemark and sign in first" state for. `maxLinks: null` keeps the cap gate
// failing open on this path too, though nothing reaches it: the sheet checks
// `sessionPresent` before it offers the form at all.
const EMPTY_TAXONOMY: ShareTaxonomy = {
  sessionPresent: false,
  lists: [],
  tags: [],
  linkCount: 0,
  maxLinks: null,
};

// --- pure builders (spec'd in share-store.spec.ts) ------------------------------

// The share sheet's list-picker rows, tree-ordered and depth-annotated by the
// shared buildTree, minus Trash ONLY (saving into the deletion staging area is
// incoherent). Takes the ALREADY-MERGED logical list set — the read edge's
// readLists() folds the system defaults in, so this stays a pure formatter and
// there is no second mergeSystemLists on this platform. Deliberately NOT
// filtered by the lock model: hide is a pure sidebar declutter and a lock gates
// a list's CONTENTS, never its use as a destination — the same only-Trash rule
// every editor picker follows (docs/editors.md, "Locked and hidden lists stay
// pickable"). Don't re-add a hiddenListIds filter here.
export function buildShareLists(lists: List[]): ShareTaxonomyList[] {
  // Trash is a no-children container (LIST_NO_CHILDREN_IDS), so buildTree never
  // nests anything under it — filtering that one root node is equivalent to the
  // old walk's `continue`, with nothing orphaned.
  const tree = buildTree(lists, { noChildrenIds: LIST_NO_CHILDREN_IDS });
  return flattenTree(tree)
    .filter((node) => node.item.id !== TRASH_ID)
    .map((node) => ({
      id: node.item.id,
      name: node.item.name,
      depth: node.depth,
      rank: node.item.rank,
    }));
}

// The tag-picker rows, in the user's rank order.
export function buildShareTags(tags: Tag[]): ShareTaxonomyTag[] {
  return tags
    .slice()
    .sort(compareRank)
    .map((tag) => ({ id: tag.id, name: tag.name, rank: tag.rank }));
}

// Defensive parses for what crosses the App Group container (the other process
// may be an older/newer build): null on any malformed payload.
export function parseShareDraft(raw: string): ShareDraft | null {
  try {
    const parsed = shareDraftSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseShareTaxonomy(raw: string): ShareTaxonomy | null {
  try {
    const parsed = shareTaxonomySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// --- db reads (Android live path + the iOS snapshot builder) -------------------

// Straight off the read edge (queries.ts) — lists come back with the system
// defaults already merged, tags as stored, both small by design. This used to
// be a local readNamespace scan "until the expo read edge lands"; it has, so
// the share surface reads through it like every other consumer. Safe in the
// iOS extension bundle too: getDb() is lazy (db.ts), so importing the read edge
// still touches no native sqlite on the snapshot path.
// The cap gate's two inputs ride along: `countLinks()` is the read edge's
// indexed, trash-inclusive count (its header is the canonical rule), and the
// cap comes from the device's cached plan. No cached status — a fresh install
// that hasn't fetched `iap/status` — writes `maxLinks: null`, i.e. fails OPEN,
// because guessing `free` would tell a paying customer their library is full.
async function readTaxonomyFromDb(): Promise<ShareTaxonomy> {
  const status = subscriptions().readCachedStatus();
  return {
    sessionPresent: true,
    lists: buildShareLists(await queries().readLists()),
    tags: buildShareTags(await queries().readTags()),
    linkCount: await queries().countLinks(),
    maxLinks: status ? entitlementsOf(status.plan).maxLinks : null,
  };
}

// --- App Group container (iOS) --------------------------------------------------

// Everything this module owns lives under one subtree, so the sign-out teardown
// can remove it wholesale rather than enumerating artifacts (clearShareData).
function shareDir(group: Directory): Directory {
  return new Directory(group, 'share');
}

function taxonomyFile(group: Directory): File {
  return new File(group, 'share/taxonomy.json');
}

function outboxDir(group: Directory): Directory {
  return new Directory(group, 'share/outbox');
}

// Where an outbox file the drain couldn't read goes (see drainShareOutbox). A
// SIBLING of the outbox, not a child: the drain must never see it again, and
// nesting it would make that depend on the scan skipping directories.
function failedDir(group: Directory): Directory {
  return new Directory(group, 'share/failed');
}

// --- the sheet's surface ---------------------------------------------------------

// What the share sheet renders its pickers from. iOS: the snapshot (missing/
// stale-schema snapshot reads as signed-out — the sheet then points at the app).
// Android: hydrate the session mirror (this may be the process's first code to
// run) and read live.
export async function loadShareTaxonomy(): Promise<ShareTaxonomy> {
  if (Platform.OS === 'ios') {
    const group = appGroupDir();
    if (!group) return EMPTY_TAXONOMY;
    const file = taxonomyFile(group);
    if (!file.exists) return EMPTY_TAXONOMY;
    return parseShareTaxonomy(file.textSync()) ?? EMPTY_TAXONOMY;
  }
  await loadSession();
  if (!getSession()) return EMPTY_TAXONOMY;
  return await readTaxonomyFromDb();
}

export type ShareSaveResult =
  // Android: written through the real write edge; the pending op syncs on the
  // next engine cycle.
  | 'saved'
  // iOS: parked in the App Group outbox; the main app drains it on next
  // launch/foreground.
  | 'queued'
  // The account is at its plan's link cap, so nothing was written. The same
  // refusal every other create surface makes (the quick-add popover, the expo
  // add screen, the extension popup all render LinkQuotaBanner instead of the
  // form). Both platforms now, off different sources — see isAtLinkCap.
  | 'quota';

// Whether a new link would exceed the plan's cap — the share sheet's copy of
// the useLinkQuota gate the other create surfaces run.
//
// THIS IS THE ENFORCEMENT, not a pre-check. The free tier's 200-link wall is
// client-side: bracemark-api's `files/sign` gate keeps
// only the byte/object backstop, so a save that gets past here syncs and stays.
// The trade was deliberate — a bypass costs ~400 KB of R2 and is bounded by
// maxBytes, while the create-vs-update machinery it bought (`existingPaths`,
// the engine's partial-push retry, a whole 'blocked-plan' sync state) was the
// error-prone half of the system.
//
// Counted trash-INCLUSIVELY: every `links/` record, trashed ones included
// (Trash is a listId, not a deletion, so the blob still exists). Same rule in
// useLinkQuota and readExistingLinks — counting only what the UI shows would
// put every surface's number under the others'.
//
// Fails OPEN wherever the answer is unknowable — no cached plan, no snapshot,
// a snapshot too old to carry the fields. A false ALLOW costs a link over the
// cap; a false REFUSE tells a paying customer their library is full.
//
// The two platforms answer from different sources, which is the process split
// and not an asymmetry in the rule: Android's share activity runs in the app's
// process and reads sqlite live, while the iOS extension can open neither the
// store nor the cached plan (this file's header), so it reads the count and the
// cap off the taxonomy snapshot the main app maintains. That snapshot is
// rewritten on every local write already — ShareBridge refreshes on
// `localWriteNonce`, which requestSync() bumps on each one — so the count is
// current as of the last time the app was open. What it can lag is a RUN of
// shares taken without reopening the app: those are gated on the count as of
// the first one, and the drain + refresh on next foreground re-syncs it.
//
// Both sources are the read edge's indexed COUNT (queries.ts `countLinks`), never
// a row read: `namespaceRows` here pulled every link's blob across to JS just to
// take `.length`, which on a large library kept over its cap (a lapsed paid plan)
// made every Add wait on a whole-library read.
export async function isAtLinkCap(): Promise<boolean> {
  if (Platform.OS === 'ios') {
    const group = appGroupDir();
    if (!group) return false;
    const file = taxonomyFile(group);
    if (!file.exists) return false;
    const snapshot = parseShareTaxonomy(file.textSync());
    if (!snapshot || snapshot.maxLinks === null) return false;
    return snapshot.linkCount >= snapshot.maxLinks;
  }
  const status = subscriptions().readCachedStatus();
  if (!status) return false;
  const { maxLinks } = entitlementsOf(status.plan);
  if (maxLinks === null) return false;
  return (await queries().countLinks()) >= maxLinks;
}

// One Add. The sheet checks `sessionPresent` before offering the form, so a
// missing session here is a programming error, not a user state. `api` is the
// app's configured client (the sheet passes it in — the baseUrl binding lives
// in the app, per the layering rules); it powers the post-write kick on both
// platforms. THE KICK IS NEVER AWAITED (docs/share-sheet.md): the durable
// commit is the local write / outbox file, so Add resolves as soon as that
// lands and the sheet shows ✓ — delivery is guaranteed by the pending op /
// next-open drain, not by the in-flight network work surviving the dismissal.
export async function saveSharedDraft(draft: ShareDraft, api: ApiClient): Promise<ShareSaveResult> {
  if (Platform.OS === 'ios') {
    // Before the outbox write, not after: a draft refused at the cap must not
    // become a file, because everything downstream of that file is designed to
    // never drop it (the drain applies it locally, the upload retries it).
    if (await isAtLinkCap()) return 'quota';
    const group = appGroupDir();
    if (!group) throw new Error('saveSharedDraft: no App Group container');
    const dir = outboxDir(group);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    new File(dir, `${draft.id}.json`).write(JSON.stringify(draft));
    // Best-effort encrypt + PUT on top of the durable outbox write
    // (share-upload.ts) — buys cross-device freshness when it lands, loses
    // nothing when it doesn't (offline, no mirrored session, process reaped
    // after close()): the drain re-uploads the same ids and LWW converges.
    void uploadQueuedDraft(api, draft);
    return 'queued';
  }
  const session = getSession();
  if (!session) throw new Error('saveSharedDraft: no session');
  if (await isAtLinkCap()) return 'quota';
  await applyShareDraft(session.username, draft);
  // Before the expired return below: a paused session stops the sync, not the
  // page fetch the main app owes this save.
  markShareHandoff(draft.id);
  // An EXPIRED session syncs nothing until a sign-in resumes it (docs/sessions.md):
  // the link is saved and queued like any offline edit, and pushes on resume.
  if (session.state === 'expired') return 'saved';
  // Inline sync kick: the pending op usually lands server-side while the share
  // activity's process is still alive (one entity, sub-second). Un-awaited JS
  // on the app-level React host IS the doc's "application/process scope" — the
  // activity's finish() doesn't cancel it; only a process reap does, and that
  // loss is covered by the pending op + the app's next sync cycle. Before the
  // first sync is done the engine declines the cycle (sync/engine.ts,
  // incrementalSyncOnce) and the op waits for the one that follows the pull.
  void engine()
    .runIncrementalSync({
      username: session.username,
      encryptionKey: session.encryptionKey,
      api,
    })
    .catch(() => undefined);
  return 'saved';
}

// The iOS extension's fire-and-forget half of saveSharedDraft. Hydrates the
// session from the shared-Keychain mirror (the extension runs no AuthProvider —
// this is also what arms the api client's bearer token), skips when the mirror
// says the session is EXPIRED (the main app recorded the server's verdict; the
// PUT would only earn it again), and swallows every failure: the outbox file
// already written is the record of truth. It reads a STATE, never a clock, and
// it never acts on a 401 itself — a verdict it provokes reaches no listener in
// this process (docs/sessions.md, _who acts on a 401_).
async function uploadQueuedDraft(api: ApiClient, draft: ShareDraft): Promise<void> {
  try {
    const session = await loadSharedSession();
    if (!session || session.state === 'expired') return;
    await shareUpload().uploadShareDraft({ encryptionKey: session.encryptionKey, api }, draft);
  } catch {
    // Best-effort by design — the main app drains the outbox on next open.
  }
}

// --- the main app's half ---------------------------------------------------------

// Land one draft through the write edge: create the new lists (top-level, the
// editors' `parentId: null` rule), then the new tags, then the link, then seed
// the provisional extraction title. Ranks come from the draft VERBATIM — minted
// in the sheet (see the header), which keeps this byte-identical with what the
// extension may have already uploaded, so LWW converges without shuffling
// anyone's order. Idempotent per the header: an existing row short-circuits its
// create; re-writing the link converges under LWW. A listId that stopped
// existing between share and apply (list deleted on another device) falls back
// to the default inbox rather than dangling.
async function applyShareDraft(username: string, draft: ShareDraft): Promise<void> {
  // readLists() already folds in the system defaults, so the validity set below
  // needs no separate SYSTEM_LIST_IDS spread.
  const existingLists = await queries().readLists();

  for (const newList of draft.newLists) {
    if (await itemStore().getItem(pathFromId(newList.id, LISTS_PREFIX))) continue;
    await mutations().writeList(
      username,
      {
        path: pathFromId(newList.id, LISTS_PREFIX),
        id: newList.id,
        name: newList.name,
        parentId: null,
        rank: newList.rank,
        createdAt: 0,
        updatedAt: 0,
      },
      {},
    );
  }

  for (const newTag of draft.newTags) {
    if (await itemStore().getItem(pathFromId(newTag.id, TAGS_PREFIX))) continue;
    await mutations().writeTag(
      username,
      {
        path: pathFromId(newTag.id, TAGS_PREFIX),
        id: newTag.id,
        name: newTag.name,
        parentId: null,
        rank: newTag.rank,
        createdAt: 0,
        updatedAt: 0,
      },
      {},
    );
  }

  const listIds = new Set<string>([
    ...existingLists.map((list) => list.id),
    ...draft.newLists.map((list) => list.id),
  ]);
  const listId =
    listIds.has(draft.listId) && draft.listId !== TRASH_ID ? draft.listId : DEFAULT_LIST_ID;

  await mutations().writeLink(
    username,
    {
      path: pathFromId(draft.id, LINKS_PREFIX),
      url: draft.url,
      listId,
      tagIds: draft.tagIds,
      createdAt: 0,
      updatedAt: 0,
    },
    {},
  );

  const title = cleanTitle(draft.title);
  if (title !== undefined) {
    await mutations().writeExtraction(username, draft.id, { fields: { title } });
  }

  // A share is a save, so it counts toward the app-store review prompt — here,
  // because both platforms' shares land through this function in the app's own
  // process (Android's Save, the iOS drain); the iOS share extension can't open
  // the sqlite the count lives in. It only counts: the sheet never asks, and the
  // ask comes on a later save in the app (bracemark-expo lib/review-prompt.ts).
  //
  // The one line here that is NOT idempotent. A draft applied twice — a drain
  // retried after a crash, two drain passes overlapping on one file — rewrites
  // the same entities and counts two saves. Left alone on purpose: the worst it
  // does is bring an ask one save forward, and the guard that would prevent it
  // ("only if the link is new") undercounts instead, since on iOS a sync pull can
  // land the extension's own upload before the drain gets to the draft.
  reviewPrompts().countReviewPromptSave();
}

// Read + parse one outbox file. Null when the bytes are unreadable OR the JSON
// doesn't match the schema — the caller treats both the same, since neither can
// be applied, and a file that throws on read would otherwise abort the whole
// drain and strand every draft behind it.
function readDraft(entry: File): ShareDraft | null {
  try {
    return parseShareDraft(entry.textSync());
  } catch {
    return null;
  }
}

// Park an unreadable outbox file out of the drain's path (see drainShareOutbox).
// Best-effort: if the move itself fails, leaving the file in the outbox is the
// least-bad outcome — the next drain retries it, and it blocks nothing in the
// meantime (the loop moves on to the next file either way).
function quarantine(group: Directory, entry: File): void {
  try {
    const dir = failedDir(group);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    entry.move(dir);
  } catch {
    // Leave it where it is; the next drain will try again.
  }
}

// Drain the iOS outbox into the local store — called by the main app on launch
// and foreground, once its store is ready (bracemark-expo's
// components/share-bridge.tsx carries why it waits). Returns the `links/` PATH of
// every draft that landed (the caller kicks a sync off `length`, and hands the
// paths to the gestured extraction — a share IS the save gesture, it just
// reaches the app here instead of through the add screen). Each file is deleted
// only AFTER its local write commits.
//
// A file the drain CAN'T READ is moved to `share/failed/`, never deleted. It
// can't stay in the outbox (it would be retried forever), but destroying it is
// worse: an outbox draft is sometimes the ONLY copy of a share — the
// best-effort upload fails exactly when the user was offline — and the drafts
// most likely to stop parsing are the ones written by an older build, since a
// parked file outlives the code that wrote it and the schemas here carry no
// back-compat slack (see the header). Quarantining keeps that class of mistake
// a recoverable bug report instead of a link the user silently never gets back.
// Nothing reads `failed/` today; sign-out clears it with everything else
// (clearShareData).
//
// No-op when signed out (the drafts wait) or on Android (no outbox exists).
export async function drainShareOutbox(): Promise<string[]> {
  if (Platform.OS !== 'ios') return [];
  const session = getSession();
  if (!session) return [];
  const group = appGroupDir();
  if (!group) return [];
  const dir = outboxDir(group);
  if (!dir.exists) return [];
  const applied: string[] = [];
  for (const entry of dir.list()) {
    if (!(entry instanceof File)) continue;
    const draft = readDraft(entry);
    if (!draft) {
      quarantine(group, entry);
      continue;
    }
    await applyShareDraft(session.username, draft);
    applied.push(pathFromId(draft.id, LINKS_PREFIX));
    entry.delete();
  }
  return applied;
}

// --- the Android handoff ---------------------------------------------------------

// Where the Android share activity leaves word of what it saved: one small file
// per link, named for the link's id and holding it, under the app's own
// document directory (there is no App Group on Android, and the activity runs
// in the app's sandbox — share-theme-store's reasoning). It exists because a
// share is a save gesture made on this device, which earns a page fetch at
// extraction mode `saves` (docs/link-extraction.md, _the stance_), and the
// fetch belongs to the main app's ExtractionProvider: the share activity mounts
// no providers, and its process may be gone seconds after Save. On iOS the
// outbox file already is this record — the drain returns the paths it landed.
// Android writes the store itself, so until this marker existed nothing told
// the app which links had arrived by share, and at `saves` they kept their
// provisional title and no image for good.
//
// A file, not a table, and not memory. Memory would do while the process that
// took the share is still the one the user comes back to, and Android reaps a
// cached process freely. A file because a marker has to survive exactly that,
// and because it is the same per-item shape the outbox already has: no
// read-modify-write, and nothing to migrate.
function handoffDir(): Directory {
  return new Directory(Paths.document, 'share/handoff');
}

// Leave the marker for one landed link. Called AFTER the link's write commits,
// so a marker only ever names a link that is in the store: the main app's pass
// can run between any two awaits of a save, and a marker it collected ahead of
// the link would be spent on a path with nothing at it. Best-effort — a marker
// that fails to land costs this share its page fetch, never the link.
function markShareHandoff(linkId: string): void {
  try {
    const dir = handoffDir();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    new File(dir, linkId).write(linkId);
  } catch {
    // The link is saved and queued either way.
  }
}

// Collect the markers — the main app's half, called by ShareBridge beside the
// iOS drain and under the same rule: only once the store is ready, since what
// the paths are handed to is inert before that. Returns the `links/` PATH of
// each, the drain's own return shape, and removes every file it read: a marker
// is a hint, never the only copy of anything, so one that cannot be read is
// dropped rather than quarantined. No-op on iOS (the outbox is the record).
//
// Never throws, and returns what it had read when something did: a path is
// collected before its file is removed, so a failed delete hands the same link
// over again on the next pass — which `extractNow` absorbs, since a link that
// is no longer pending is not fetched twice — where the other order would lose
// it.
export function takeShareHandoffs(): string[] {
  if (Platform.OS !== 'android') return [];
  const paths: string[] = [];
  try {
    const dir = handoffDir();
    if (!dir.exists) return paths;
    for (const entry of dir.list()) {
      if (!(entry instanceof File)) continue;
      let linkId = '';
      try {
        linkId = entry.textSync();
      } catch {
        // Unreadable: nothing to hand on.
      }
      if (linkId) paths.push(pathFromId(linkId, LINKS_PREFIX));
      entry.delete();
    }
  } catch {
    // What was read is handed on; the rest waits for the next pass.
  }
  return paths;
}

// Rewrite the iOS taxonomy snapshot from the current store — called by the main
// app whenever lists/tags change and after sign-in/first sync. No-op on
// Android (the share activity reads live) and when signed out (clearShareData
// owns removal).
export async function refreshShareTaxonomy(): Promise<void> {
  if (Platform.OS !== 'ios') return;
  if (!getSession()) return;
  const group = appGroupDir();
  if (!group) return;
  const taxonomy = await readTaxonomyFromDb();
  const file = taxonomyFile(group);
  if (!file.exists) file.create({ intermediates: true, overwrite: true });
  file.write(JSON.stringify(taxonomy));
}

// Remove everything share-related from the App Group container — part of the
// sign-out teardown (clear-data.ts): the snapshot names the account's lists and
// tags, and the outbox (plus its `failed/` quarantine) may hold undrained URLs,
// none of which may outlive the session or leak to the next account. Deletes the
// whole `share/` subtree rather than naming each artifact, so anything added
// under it later is covered by construction — an enumeration here is exactly the
// kind of list that silently misses the next addition. Failure-tolerant like the
// rest of the teardown's file half.
//
// Android has one artifact, the handoff markers: link ids of this account's,
// which the next account's ExtractionProvider must never be handed. Only that
// directory goes — the theme mirror beside it is rewritten by the app itself
// (share-theme-store.ts).
export function clearShareData(): void {
  if (Platform.OS === 'android') {
    // Guarded, because this call was a no-op on Android until the markers
    // existed and the steps after it in clearData must still run.
    try {
      const dir = handoffDir();
      if (dir.exists) dir.delete();
    } catch {
      // A launch with no session runs the teardown again. A marker that outlives
      // even that names a link the next account's store does not hold, so the
      // pass that collects it fetches nothing.
    }
    return;
  }
  if (Platform.OS !== 'ios') return;
  const group = appGroupDir();
  if (!group) return;
  const dir = shareDir(group);
  if (dir.exists) dir.delete();
}
