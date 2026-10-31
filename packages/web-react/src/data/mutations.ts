'use client';

// The LOCAL WRITE EDGE — the mirror of queries.ts's read edge. A UI edit lands
// here first: it writes the decrypted blob into `items` and enqueues a pending op,
// in ONE transaction, then the sync engine drains the queue (encrypt → PUT →
// commit) on the next cycle. This is the "the UI writes the local store, then
// enqueues a pending op" path the db.ts/engine.ts comments describe; nothing else
// in the app wrote `items` before — only the engine did, on the way down.
//
// Two stores in one transaction so a write is atomic: the local store and the
// durable queue can never disagree about whether an edit happened (a crash
// between them would either lose the edit or orphan a queue entry). The engine
// restamps `items.updatedAt` with R2's authoritative time on commit, so the
// local value here is provisional — we keep the pre-edit server stamp as the
// base, which is exactly what reconcile compares against.

import {
  dropCachedPath,
  type Extraction,
  EXTRACTIONS_PREFIX,
  extractionSchema,
  type Facet,
  FILES_PREFIX,
  type Link,
  linkSchema,
  type LinksLayout,
  type LinkSortOn,
  type LinkSortOrder,
  type List,
  listSchema,
  pathFromId,
  type Pin,
  PINS_PREFIX,
  pinSchema,
  replacedExtractionFileIds,
  SETTINGS_GENERAL_PATH,
  type SettingsGeneral,
  settingsGeneralSchema,
  type Tag,
  tagSchema,
  type ThemeState,
  utf8,
} from '@stxapps/shared';

import { db, type ItemRecord, type PendingOpRecord } from './db';
import { enqueueDelete, enqueuePut, pendingDeleteRecord, pendingPutRecord } from './pending-store';
import { parseBlob, toItemRecord } from './projection';
import { type LinkItem, toItem, type WithPath } from './queries';
import { assertAccountStillOwnsStore } from './sync-store';

// The stores every local write's rw transaction locks: the record, its pending op, and
// `syncMeta` for assertAccountStillOwnsStore's read. ONE list, because flushLocalWrites
// is only a barrier while its scope overlaps every write's — a write that grew a store
// this list lacks would silently stop being waited for.
const WRITE_EDGE_STORES = [db.items, db.pendingOps, db.syncMeta];

// Resolve once every local write already started on this page has COMMITTED. A
// read-only transaction over the write edge's stores queues behind every earlier
// read-write transaction that touches them (IndexedDB orders overlapping scopes),
// so it starts only after they commit — which is what makes a reload right after a
// Save lose nothing (the "updated, reload" pill, docs/offline-mode.md). A closed
// database (update-required) has nothing to wait for.
export async function flushLocalWrites(): Promise<void> {
  try {
    await db.transaction('r', WRITE_EDGE_STORES, () => undefined);
  } catch {
    // Closed or unavailable: no write can still be landing.
  }
}

// Persist one path's bytes locally and queue the upload, producing the bytes INSIDE
// the transaction from the path's current record — the base primitive the JSON-entity
// paths (writeEntity, and its merging sibling writeEntityWith) and the opaque-media path
// (writeFile) all share. A `files/{id}.enc` content blob stores its bytes verbatim, a
// JSON entity stores its encoded blob, but both do the same local-put + pending-op in
// one transaction; the sync engine encrypts + PUTs downstream like any other op.
//
// `produce` runs under the SAME rw lock that does the put and sees the existing record
// (or `undefined`). That's what closes the lost-update window for read-merge writers:
// IndexedDB serializes overlapping rw transactions on `db.items`, so no concurrent
// write can land between the producer's read of the prior blob and its put. A merge can
// therefore read-modify-write a single shared path (`settings/general.enc`, one
// `extractions/{id}.enc` racing two facet completions) without losing the other side's
// fields/facets.
//
// `baseUpdatedAt` is the path's current server stamp (0 if it has no record yet —
// a fresh create, including the first edit of an untouched system-list default):
// the base reconcile diffs the next pulled stamp against to tell our own echo
// from a real conflict. The local `items.updatedAt` is left at that base until
// the commit restamps it.
async function writeBytesWith(
  username: string,
  path: string,
  produce: (existing: ItemRecord | undefined) => Uint8Array,
): Promise<void> {
  await db.transaction('rw', WRITE_EDGE_STORES, async () => {
    await assertAccountStillOwnsStore(username);
    const existing = await db.items.get(path);
    const baseUpdatedAt = existing?.updatedAt ?? 0;
    const bytes = produce(existing);
    await db.items.put(toItemRecord(path, baseUpdatedAt, bytes));
    // Through enqueuePut (which joins this transaction) rather than an inline
    // `pendingOps.put`, so every queued op is stamped with a `writeId` in ONE place —
    // an untagged row would be indistinguishable from the op a drain is holding, and
    // silently re-acquire the blind-delete-by-path bug (db.ts `writeId`).
    await enqueuePut(username, path, baseUpdatedAt);
  });
  // AFTER the commit: the read layer's memo is versioned by (updatedAt,
  // itemUpdatedAt), and a local write freezes the first while the second has only
  // millisecond resolution — so two writes to one path inside a millisecond are
  // invisible to it and the reader would keep serving the first one's decode
  // (@stxapps/shared sync/decode-cache.ts). Every local write goes through here, so
  // this one line is the whole invalidation.
  dropCachedPath(path);
}

// Persist already-formed bytes — the non-merging fast path (writeEntity, writeFile),
// where the bytes don't depend on the path's current record. Thin over writeBytesWith
// with a producer that ignores the existing record.
function writeBytes(username: string, path: string, bytes: Uint8Array): Promise<void> {
  return writeBytesWith(username, path, () => bytes);
}

// The merging sibling of writeEntity: produce the entity blob INSIDE the transaction
// from the path's current record, then encode + put it — the layer the read-merge-write
// entities (writeSettingsGeneral, writeExtraction) sit on. Keeps the same agnostic/JSON
// split: writeBytesWith stays byte-opaque (it also carries writeFile's verbatim media),
// the JSON encode lives here in one place. `produce` returns the PATHLESS blob — `path`
// is the store key, reconstructed from the namespace on read, never inside the ciphertext
// (entities.ts) — so there's nothing to strip before encoding.
async function writeEntityWith<T extends object>(
  username: string,
  path: string,
  produce: (existing: ItemRecord | undefined) => T,
): Promise<void> {
  await writeBytesWith(username, path, (existing) => utf8(JSON.stringify(produce(existing))));
}

// Persist one entity locally and queue it for upload — the JSON-entity path layered
// over writeBytes. `item` carries its `path` (the app-only store key); everything
// else is the blob to encrypt, so `path` is stripped before encoding — it's
// reconstructed from the namespace on read, never stored inside the ciphertext (see
// entities.ts on reference ids vs. paths). The encoded blob then goes through the
// shared writeBytes primitive, so the local-put + pending-op atomicity (and the
// `baseUpdatedAt` base-stamp handling) lives in one place.
async function writeEntity<T extends WithPath<object>>(username: string, item: T): Promise<void> {
  const { path, ...entity } = item;
  await writeEntityWith(username, path, () => entity);
}

// One raw entity to bulk-write: a pre-validated entity blob (JSON-encoded here),
// or verbatim bytes for a `files/{id}.enc` content record — the same JSON/opaque
// split writeEntity/writeFile make, batched.
export interface RawEntityEntry {
  path: string;
  data: object | Uint8Array;
}

// Batched raw put — the bulk-import primitive (data/import-all-data.ts). N entities land
// in ONE rw transaction (items.bulkPut + pendingOps.bulkPut), so a chunk is
// atomic like any single write and IndexedDB isn't asked for a transaction per
// link. Unlike writeLink/writeList this does NOT restamp createdAt/updatedAt:
// the importer provides final values (a Bracemark-backup restore round-trips the
// original timestamps), and callers validate each blob against its namespace
// schema BEFORE calling — the same defensive parity, just hoisted out of the
// batch. `baseUpdatedAt` per path from its existing record (0 for new), exactly
// like writeBytesWith. With skipExisting, the existence check shares the write
// transaction: an import's earlier scan is only a snapshot, and sync can land a
// path while the importer yields. Returns the paths actually written.
export async function bulkWriteEntities(
  username: string,
  entries: RawEntityEntry[],
  options: { skipExisting?: boolean } = {},
): Promise<string[]> {
  if (entries.length === 0) return [];
  const written: string[] = [];
  await db.transaction('rw', WRITE_EDGE_STORES, async () => {
    await assertAccountStillOwnsStore(username);
    const existing = await db.items.bulkGet(entries.map((entry) => entry.path));
    const records: ItemRecord[] = [];
    const ops: PendingOpRecord[] = [];
    for (let i = 0; i < entries.length; i++) {
      const { path, data } = entries[i];
      if (options.skipExisting && existing[i] !== undefined) continue;
      written.push(path);
      const baseUpdatedAt = existing[i]?.updatedAt ?? 0;
      const bytes = data instanceof Uint8Array ? data : utf8(JSON.stringify(data));
      records.push(toItemRecord(path, baseUpdatedAt, bytes));
      // Through the shared factory, not an inline row literal: an op without a
      // `writeId` is indistinguishable from the one a drain is holding, so an import
      // whose entities are re-edited mid-drain would lose those edits (db.ts).
      ops.push(pendingPutRecord(username, path, baseUpdatedAt));
    }
    await db.items.bulkPut(records);
    await db.pendingOps.bulkPut(ops);
  });
  for (const path of written) dropCachedPath(path);
  return written;
}

// Batched delete by path — the delete-side twin of bulkWriteEntities, and what a
// bulk action's sweep lands as: N paths leave `items` and N tombstones enter the
// queue in ONE rw transaction, instead of a transaction (and a liveQuery re-run,
// and a repaint) per path. `baseUpdatedAt` per path from its existing record, 0
// for one with none — a never-stored default, an already-gone pin — exactly like
// deleteEntity, which stays the single-path spelling.
//
// One transaction also RETIRES the ordering rule the per-path callers had to
// follow. `destroy` deletes a link's `files/` content before its entities so an
// interruption leaves a dangling ref (reads as "no bytes") rather than orphaned
// blobs; batched, there is no interruption to order around — the whole sweep
// commits or none of it does.
export async function bulkDeleteEntities(username: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await db.transaction('rw', WRITE_EDGE_STORES, async () => {
    await assertAccountStillOwnsStore(username);
    const existing = await db.items.bulkGet(paths);
    // Through the shared factory, never an inline row literal — see
    // bulkWriteEntities, and db.ts on `writeId`.
    const ops = paths.map((path, i) =>
      pendingDeleteRecord(username, path, existing[i]?.updatedAt ?? 0),
    );
    await db.items.bulkDelete(paths);
    await db.pendingOps.bulkPut(ops);
  });
  for (const path of paths) dropCachedPath(path);
}

// Delete one entity by path: drop the local record and queue the server delete in
// the SAME transaction, mirroring writeEntity's atomicity (the store and the
// durable queue can never disagree about whether the delete happened).
// `baseUpdatedAt` is the path's current server stamp — the base the next reconcile
// diffs our own echo against, exactly as on the put path. A path with no local
// record (a never-stored system-list default, an already-gone pin) makes the
// delete a no-op locally and a harmless tombstone upstream. Entity-agnostic so
// every namespace deletes by one definition; the named per-namespace deletes
// below are the public surface, and callers gate the higher-level rules.
async function deleteEntity(username: string, path: string): Promise<void> {
  await db.transaction('rw', WRITE_EDGE_STORES, async () => {
    await assertAccountStillOwnsStore(username);
    const existing = await db.items.get(path);
    const baseUpdatedAt = existing?.updatedAt ?? 0;
    await db.items.delete(path);
    await enqueueDelete(username, path, baseUpdatedAt);
  });
  // Same invalidation as the put path: a re-create landing in the same millisecond
  // would otherwise read back the pre-delete decode.
  dropCachedPath(path);
}

// The user-authored fields an edit may touch — `links/{id}.enc` is the user half
// of a link, so this is everything on it except identity/timestamps. The extracted
// display fields (title/imageId/pageCopyId/screenshotId) are NOT here: they live
// in `extractions/{id}.enc` and are written via writeExtraction, so a background
// extractor never rewrites this file (see docs/link-extraction.md). An EXPLICITLY
// undefined field clears it: the spread overwrites the old value and JSON encoding
// drops the key, so e.g. `{ customTitle: undefined }` reverts to the extracted title.
export type LinkPatch = Partial<
  Pick<Link, 'url' | 'tagIds' | 'listId' | 'note' | 'customTitle' | 'customImageId'>
>;

// One link's share of a batched write (bulkWriteLinks). PER-LINK rather than one
// patch for the whole batch, because the retag dialog's patch genuinely differs
// row by row: "add these tags, remove those" resolves against each link's own
// `tagIds`. The uniform actions (move, archive, restore, remove) just map the
// same patch across their selection.
export interface LinkEdit {
  link: WithPath<Link>;
  patch: LinkPatch;
}

// Apply a patch to a link and write it — create (new `links/{id}.enc`) or edit.
// Stamps `updatedAt` now so the in-blob "date modified" advances on EVERY edit;
// that's what keeps the `[itemType+itemUpdatedAt]` sort indexes (db.ts) and the
// decode cache's version (decode-cache.ts) correct — both ride on `itemUpdatedAt`,
// which the projector derives from this field. On first write (`createdAt === 0`)
// stamps `createdAt` too, so a fresh link looks like any other created entity.
// Validated against `linkSchema` before the write (TS-narrows the spread back to a
// Link), the same defensive parity writeList/writePin have.
export async function writeLink(
  username: string,
  link: WithPath<Link>,
  patch: LinkPatch,
): Promise<void> {
  const now = Date.now();
  const next: WithPath<Link> = {
    // `toItem` first: callers hand us a ROW SNAPSHOT, which is a `LinkView` at
    // every UI call site, and its four joined display fields must not be spread
    // into the blob (see toItem — nothing downstream would report it).
    ...toItem(link),
    ...patch,
    createdAt: link.createdAt === 0 ? now : link.createdAt,
    updatedAt: now,
  };
  const { path: _path, ...blob } = next;
  if (!linkSchema.safeParse(blob).success) {
    throw new Error(`writeLink: invalid link ${link.path}`);
  }
  await writeEntity(username, next);
}

// Apply N patched links in ONE transaction — what a bulk action (move to list,
// archive, restore, remove, retag) writes instead of N writeLink calls. Same
// per-link semantics as writeLink (stamps `updatedAt`, stamps `createdAt` on a
// first write, validates against `linkSchema` before the write), so a batched move
// and a single-row move produce byte-identical blobs.
//
// It also does what `useLinkMutations.update` has to do OUTSIDE its write — re-read
// the current blob, since the caller's `links` are row/dialog snapshots and a sync
// may have landed a fresher one since they rendered. Here that read is INSIDE the rw
// lock, so unlike the single-path spelling there is no window between the read and
// the put at all. A link that's gone entirely (deleted on another device) falls back
// to the snapshot and is recreated — the same honest LWW outcome for edit-vs-delete
// that `update` takes.
export async function bulkWriteLinks(username: string, edits: LinkEdit[]): Promise<void> {
  if (edits.length === 0) return;
  const now = Date.now();
  await db.transaction('rw', WRITE_EDGE_STORES, async () => {
    await assertAccountStillOwnsStore(username);
    const existing = await db.items.bulkGet(edits.map((edit) => edit.link.path));
    const records: ItemRecord[] = [];
    const ops: PendingOpRecord[] = [];
    for (let i = 0; i < edits.length; i++) {
      const { link, patch } = edits[i];
      const { path, ...snapshot } = link;
      const record = existing[i];
      const stored = record ? parseBlob(record.data, linkSchema) : undefined;
      // The stored blob is clean by construction; the snapshot fallback is a row
      // the UI is holding, so it goes through the same strip writeLink applies.
      const current: Link = stored ?? toItem(snapshot as LinkItem);
      const next: Link = {
        ...current,
        ...patch,
        createdAt: current.createdAt === 0 ? now : current.createdAt,
        updatedAt: now,
      };
      if (!linkSchema.safeParse(next).success) {
        throw new Error(`bulkWriteLinks: invalid link ${path}`);
      }
      const baseUpdatedAt = record?.updatedAt ?? 0;
      records.push(toItemRecord(path, baseUpdatedAt, utf8(JSON.stringify(next))));
      ops.push(pendingPutRecord(username, path, baseUpdatedAt));
    }
    await db.items.bulkPut(records);
    await db.pendingOps.bulkPut(ops);
  });
  // Same invalidation every local write owes the read layer's memo (writeBytesWith).
  for (const edit of edits) dropCachedPath(edit.link.path);
}

// Delete one link: drop its `links/{id}.enc`. Thin like deleteList/deletePin —
// higher-level cleanup (its pin, its `files/` content) is the caller's concern.
export function deleteLink(username: string, link: WithPath<Link>): Promise<void> {
  return deleteEntity(username, link.path);
}

// Apply a patch to a list and write it. Stamps `updatedAt` now; if this is the
// FIRST edit of an untouched system-list default (`createdAt === 0`, never
// stored), stamps `createdAt` now too so the override blob looks like any other
// created entity. Validated against `listSchema` before the write so a bad patch
// can't poison the store (and TS-narrows the spread back to a List).
export async function writeList(
  username: string,
  list: WithPath<List>,
  patch: Partial<Pick<List, 'name' | 'parentId' | 'rank'>>,
): Promise<void> {
  const now = Date.now();
  const next: WithPath<List> = {
    ...list,
    ...patch,
    createdAt: list.createdAt === 0 ? now : list.createdAt,
    updatedAt: now,
  };
  // Defensive parity with the read edge: the same schema gates both directions.
  // `path` is the store key, not part of the blob — drop it before validating.
  const { path: _path, ...blob } = next;
  if (!listSchema.safeParse(blob).success) {
    throw new Error(`writeList: invalid list ${list.id}`);
  }
  await writeEntity(username, next);
}

// Delete one list. Callers gate the higher-level rules (system lists aren't
// deletable, a non-empty list keeps its links) before reaching here.
export function deleteList(username: string, list: WithPath<List>): Promise<void> {
  return deleteEntity(username, list.path);
}

// Apply a patch to a tag and write it — create (new `tags/{id}.enc`) or edit.
// Identical shape to writeList (tags are the same one-file-per-entity tree, just
// without the system-list defaults): stamps `updatedAt` now, stamps `createdAt`
// on first write (`createdAt === 0`), and validates against `tagSchema` before
// the write so a bad patch can't poison the store (TS-narrows the spread back to
// a Tag). `path` is the store key, dropped before validating the blob.
export async function writeTag(
  username: string,
  tag: WithPath<Tag>,
  patch: Partial<Pick<Tag, 'name' | 'parentId' | 'rank'>>,
): Promise<void> {
  const now = Date.now();
  const next: WithPath<Tag> = {
    ...tag,
    ...patch,
    createdAt: tag.createdAt === 0 ? now : tag.createdAt,
    updatedAt: now,
  };
  const { path: _path, ...blob } = next;
  if (!tagSchema.safeParse(blob).success) {
    throw new Error(`writeTag: invalid tag ${tag.id}`);
  }
  await writeEntity(username, next);
}

// Delete one tag: drop its `tags/{id}.enc`. Thin like deleteList — a dangling
// `tagIds` reference left on a link is NORMAL and skipped at read time
// (entities.ts), so there's no link rewrite to do here.
export function deleteTag(username: string, tag: WithPath<Tag>): Promise<void> {
  return deleteEntity(username, tag.path);
}

// Apply a patch to a pin and write it — the put side of pin/reorder. Stamps
// `updatedAt` now and, on first write (`createdAt === 0`), `createdAt` too, so a
// freshly-pinned link's blob looks like any other created entity. Validated
// against `pinSchema` before the write (TS-narrows the spread back to a Pin), the
// same defensive parity writeList has. Only `rank` is ever patched today.
export async function writePin(
  username: string,
  pin: WithPath<Pin>,
  patch: Partial<Pick<Pin, 'rank'>>,
): Promise<void> {
  const now = Date.now();
  const next: WithPath<Pin> = {
    ...pin,
    ...patch,
    createdAt: pin.createdAt === 0 ? now : pin.createdAt,
    updatedAt: now,
  };
  const { path: _path, ...blob } = next;
  if (!pinSchema.safeParse(blob).success) {
    throw new Error(`writePin: invalid pin ${pin.id}`);
  }
  await writeEntity(username, next);
}

// Unpin: delete the link's `pins/{id}.enc` marker. Keyed by the link's id (a pin
// shadows its link — entities.ts), mirroring writeExtraction/deleteExtraction so
// callers never build the path themselves. The link itself is untouched (separate
// file).
export function deletePin(username: string, linkId: string): Promise<void> {
  return deleteEntity(username, pathFromId(linkId, PINS_PREFIX));
}

// Patch the synced general-settings blob (`settings/general.enc`) and write it —
// the SYNCED side of a setting (the "Sync" tab), so it rides the same
// pending-op → R2 path as every other entity. Unlike the others this is a single
// well-known path, not a per-id create, so it READS the current blob and merges —
// and that read-merge runs INSIDE the write transaction (via writeBytesWith) so a
// concurrent write to the same path can't slip between the read and the put. The
// schema is `looseObject`, so an unknown field a newer client wrote (or another
// general setting) is round-tripped, not stripped (see entities.ts). An absent blob
// starts from `createdAt: 0`, exactly like the first edit of an untouched
// system-list default. Stamps `updatedAt` now (and `createdAt` on first write),
// validates, then writes.
//
// The patch is typed field-by-field rather than `Pick`ed off `SettingsGeneral`,
// because this is the WRITE edge and `SettingsGeneral` is the tolerant READ shape:
// its `linksLayout` is a free `string` so that a future client's layout round-trips
// (entities.ts), and `Pick`ing that here would let us write any string ourselves.
// Writers stay strict — `LinksLayout` — while readers stay forgiving.
export async function writeSettingsGeneral(
  username: string,
  patch: {
    linksLayout?: LinksLayout;
    serverExtraction?: boolean;
    keepReadModeOnSave?: boolean;
    keepScreenshotOnSave?: boolean;
    theme?: ThemeState;
    sortOn?: LinkSortOn;
    sortOrder?: LinkSortOrder;
  },
): Promise<void> {
  const now = Date.now();
  await writeEntityWith(username, SETTINGS_GENERAL_PATH, (existing) => {
    const current: SettingsGeneral = parseBlob(existing?.data, settingsGeneralSchema) ?? {
      createdAt: 0,
      updatedAt: 0,
    };
    const next: SettingsGeneral = {
      ...current,
      ...patch,
      createdAt: current.createdAt === 0 ? now : current.createdAt,
      updatedAt: now,
    };
    if (!settingsGeneralSchema.safeParse(next).success) {
      throw new Error('writeSettingsGeneral: invalid settings');
    }
    return next;
  });
}

// One extraction facet name (`titleImage` | `screenshot` | …) — the keys of an
// extraction's `facets` map (entities.ts). The background extraction worker writes
// one of these per capture.
export type ExtractionFacet = keyof Extraction['facets'];

// The machine-written display fields on `extractions/{id}.enc` — the extracted
// counterparts of the user's `customTitle`/`customImageId` on the link.
export type ExtractionFields = Partial<
  Pick<Extraction, 'title' | 'imageId' | 'readModeId' | 'screenshotId' | 'pageCopyId'>
>;

// What one extraction write-back carries: an optional display-field patch and/or one
// facet's bookkeeping. Both ride a SINGLE read-merge-write so a completion writes one
// file (the writer-split removed the second, `links/` backfill write) and the field +
// its facet status can't race each other.
export interface ExtractionPatch {
  fields?: ExtractionFields;
  facet?: ExtractionFacet;
  state?: Facet;
}

// Read-merge-write one link's `extractions/{id}.enc` — the MACHINE half of a link
// (entities.ts): the extracted display result (title/imageId/pageCopyId/
// screenshotId) AND the per-facet who/when/quality/retry bookkeeping. The extractor
// writes ONLY this file, never `links/{id}.enc`, so it can never clobber a concurrent
// user edit (the writer-split — docs/link-extraction.md). The read-merge-`put` runs
// INSIDE the write transaction (via writeBytesWith) so two facet completions racing on
// the SAME `extractions/{id}.enc` can't lose each other's fields/facets — IndexedDB
// serializes the overlapping rw transactions, so the second sees the first's merged
// blob. `looseObject` round-trips anything a newer client wrote. `linkId` is the link's
// id (the `{id}` of its `links/{id}.enc`), which is also this entity's id and path id.
export async function writeExtraction(
  username: string,
  linkId: string,
  patch: ExtractionPatch,
): Promise<void> {
  const now = Date.now();
  const path = pathFromId(linkId, EXTRACTIONS_PREFIX);
  // The `files/` blobs this write stops referencing — a re-capture's predecessor, a tier
  // upgrade's old preview. Collected inside the merge (the only place `current` is the
  // committed value) and deleted after the put, metadata before content on the way down.
  let replaced: string[] = [];
  await writeEntityWith(username, path, (existing) => {
    const current: Extraction = parseBlob(existing?.data, extractionSchema) ?? {
      id: linkId,
      facets: {},
      createdAt: 0,
      updatedAt: 0,
    };

    // A `failed` write is one consumed retry: derive `attempts` from the prior facet just
    // read (prior + 1, the real cross-cycle counter) rather than trusting the caller's blind
    // `state.attempts`, so `backoff(attempts)` escalates across repeated failures (each retry
    // waits longer, up to the cap) instead of staying flat. The WRITER owns the number because
    // only this read-merge sees the prior value; on a `failed` write `state.attempts` is a
    // placeholder that's overridden. Keying off `status` (not a separate flag) makes the
    // increment impossible to set inconsistently — a `failed` write can't forget to count, and
    // `done`/`permanent` (terminal — `done` carries `attempts: 0`) never wrongly bump. The
    // prior read shares the put's transaction, so the count is exact even under concurrent
    // facet completions — no lost increment to absorb.
    const facets =
      patch.facet && patch.state
        ? {
            ...current.facets,
            [patch.facet]:
              patch.state.status === 'failed'
                ? { ...patch.state, attempts: (current.facets[patch.facet]?.attempts ?? 0) + 1 }
                : patch.state,
          }
        : current.facets;
    const next: Extraction = {
      ...current,
      ...patch.fields,
      facets,
      createdAt: current.createdAt === 0 ? now : current.createdAt,
      updatedAt: now,
    };
    if (!extractionSchema.safeParse(next).success) {
      throw new Error(`writeExtraction: invalid extraction ${linkId}`);
    }
    replaced = replacedExtractionFileIds(current, next);
    return next;
  });
  // Nothing else would ever reclaim these: the sweep and the destroy paths find blobs
  // through the extraction's CURRENT refs, so a replaced one counted against the quota on
  // every device for as long as the account lived. If this is interrupted the blob stays
  // orphaned, which is where every replaced blob used to end up anyway.
  for (const fileId of replaced) await deleteFile(username, fileId);
}

// The kept copies a user can remove one at a time, and the display field each one's
// blob hangs off. Page copy joins when it exists.
export type KeptCopyFacet = 'readMode' | 'screenshot';
const KEPT_COPY_FIELD = { readMode: 'readModeId', screenshot: 'screenshotId' } as const;

// Remove one kept copy of one link: drop its ref from `extractions/{id}.enc`, mark
// the facet REMOVED, then delete the blob (metadata before content on the way down,
// as writeExtraction does for a replaced one). docs/link-extraction-keep.md,
// _removal, cleanup, export_.
//
// The facet stays `done` with a `removedAt` passthrough — it is NOT deleted. An
// absent facet reads as "not taken yet", which a bulk job or a future drain would
// take again; `done` with no ref reads as "taken, and the user threw it away", and
// nothing automatic re-takes a `done` facet. An explicit ask still can (the browser
// extension's saved screen keys "kept" on the ref, not the status). `removedAt`
// rides the facet's looseObject, so an older client round-trips it, and it adds no
// value to `facetSchema.status` — which is a z.enum an older client would fail on
// (the keep doc's tripwire).
//
// Returns whether anything was removed: no extraction, or one without this copy, is
// a no-op that writes nothing (a bulk removal over a selection is mostly these).
export async function removeKeptCopy(
  username: string,
  linkId: string,
  facet: KeptCopyFacet,
): Promise<boolean> {
  const field = KEPT_COPY_FIELD[facet];
  const path = pathFromId(linkId, EXTRACTIONS_PREFIX);
  const existing = await readExtractionRecord(path);
  if (!existing?.[field]) return false;

  const now = Date.now();
  let removed: string[] = [];
  try {
    await writeEntityWith(username, path, (record) => {
      const current = parseBlob(record?.data, extractionSchema);
      // Re-checked inside the transaction: a sync may have landed between the read
      // above and this write. Nothing to remove now — ABORT, never write back: the
      // extraction may have been deleted meanwhile, and writing the earlier copy
      // would resurrect it (the dangling-extraction race, made by us).
      if (!current?.[field]) throw NOTHING_TO_REMOVE;
      const prior = current.facets[facet];
      const next: Extraction = {
        ...current,
        [field]: undefined,
        facets: {
          ...current.facets,
          [facet]: {
            ...(prior ?? { status: 'done', attempts: 0 }),
            status: 'done',
            removedAt: now,
          },
        },
        updatedAt: now,
      };
      if (!extractionSchema.safeParse(next).success) {
        throw new Error(`removeKeptCopy: invalid extraction ${linkId}`);
      }
      removed = replacedExtractionFileIds(current, next);
      return next;
    });
  } catch (err) {
    if (err === NOTHING_TO_REMOVE) return false;
    throw err;
  }
  for (const fileId of removed) await deleteFile(username, fileId);
  return removed.length > 0;
}

// Thrown inside removeKeptCopy's write to abort its transaction (rolling back the
// pending op with it) when the copy is already gone.
const NOTHING_TO_REMOVE = Symbol('nothing to remove');

// The current extraction for a path, decoded, outside any transaction — the cheap
// pre-check that lets removeKeptCopy skip a write when there is nothing to remove.
async function readExtractionRecord(path: string): Promise<Extraction | undefined> {
  const record = await db.items.get(path);
  return parseBlob(record?.data, extractionSchema);
}

// Delete one link's `extractions/{id}.enc` — the machine half's counterpart of
// deleteLink, keyed by the link's id like writeExtraction so callers never build
// the path themselves. The `files/` blobs the extraction references are the
// caller's concern (same split as deleteLink's header).
export function deleteExtraction(username: string, linkId: string): Promise<void> {
  return deleteEntity(username, pathFromId(linkId, EXTRACTIONS_PREFIX));
}

// Write a `files/{id}.enc` content blob (a captured screenshot/page-copy/read-mode
// file). Only the lazy content record is created here; the reference to it
// (`imageId` / `screenshotId` / `pageCopyId`) is written separately via
// writeExtraction, content-before-metadata — the same ordering the sync engine's push
// phases preserve.
export function writeFile(username: string, fileId: string, data: Uint8Array): Promise<void> {
  return writeBytes(username, pathFromId(fileId, FILES_PREFIX), data);
}

// Delete a `files/{id}.enc` content blob — the counterpart of writeFile, for a
// replaced/cleared custom image or a destroyed link's content. Metadata-before-content
// on the way down: callers drop the reference (via writeLink/writeExtraction) before
// or with the blob delete; a briefly-dangling ref is NORMAL and read as "no bytes yet"
// (readFileBytes → undefined), same as a not-yet-materialized lazy blob.
export function deleteFile(username: string, fileId: string): Promise<void> {
  return deleteEntity(username, pathFromId(fileId, FILES_PREFIX));
}
