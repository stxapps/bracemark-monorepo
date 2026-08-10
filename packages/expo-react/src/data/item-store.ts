// Read/write helpers over the `items` table and its junction tables — where web
// calls Dexie's `db.items` directly, expo funnels through this store so the
// db.ts invariant has one owner: the junction rows (`item_tag_ids`,
// `item_facet_statuses`) are written in the SAME transaction as their `items`
// row, from the SAME projected record (projection.ts), so the queryable
// projection can never drift from the bytes it was derived from. Deliberately
// tiny and side-effect-light — no network, no React — like its sibling stores
// (pending-store, sync-store).
//
// Reads return the raw nullable row (`ItemRow`); `ItemRecord` (projection.ts,
// undefined-based) is the write-side shape. The engine only ever reads the sync
// fields (`updatedAt`, `data`, `hasDataFile`), so reads don't join the junction
// tables back in — the read layer queries those directly.

import { and, eq, gte, inArray, lt } from 'drizzle-orm';

import { chunk } from '@stxapps/shared';

import { type DbTx, getDb, itemFacetStatuses, items, itemTagIds, prefixEnd } from './db';
// The queue's owner answers "is this path queued?" — this store composes that read
// into its own guarded writes (putItemsUnqueued / deleteItemsUnqueued) rather than
// querying `pending_ops` itself. One direction only; pending-store never imports back.
import { queuedPathsTx } from './pending-store';
import type { ItemRecord } from './projection';

export type ItemRow = typeof items.$inferSelect;

// Keep `IN (...)` lists comfortably under SQLite's bound-variable ceiling; the
// engine's batches (≤1000 paths) split into a couple of chunks.
const IN_BATCH = 500;

// Full-replace row semantics, like Dexie's `put`: every column is set, so a
// field the record omits is cleared, not kept. `hasDataFile` in particular
// always resets to null here — the projector never sets it (projection.ts), and
// a re-stored content record SHOULD drop its materialization claim (the engine
// deletes the on-disk plaintext in the same breath); loadEntityContent re-marks
// it after it re-materializes.
function toRow(r: ItemRecord): ItemRow {
  return {
    path: r.path,
    updatedAt: r.updatedAt,
    data: r.data ?? null,
    hasDataFile: null,
    itemType: r.itemType ?? null,
    itemCreatedAt: r.itemCreatedAt ?? null,
    itemUpdatedAt: r.itemUpdatedAt ?? null,
    itemListId: r.itemListId ?? null,
    itemUrl: r.itemUrl ?? null,
    itemUrlKey: r.itemUrlKey ?? null,
  };
}

export async function getItem(path: string): Promise<ItemRow | undefined> {
  return getDb().select().from(items).where(eq(items.path, path)).get();
}

// Order-aligned with the input like Dexie's bulkGet: result[i] is paths[i]'s
// row, or undefined if unknown locally.
export async function bulkGetItems(paths: string[]): Promise<(ItemRow | undefined)[]> {
  const byPath = new Map<string, ItemRow>();
  for (const batch of chunk(paths, IN_BATCH)) {
    const rows = getDb().select().from(items).where(inArray(items.path, batch)).all();
    for (const row of rows) byPath.set(row.path, row);
  }
  return paths.map((p) => byPath.get(p));
}

// The third key shape, after one path and many: every row under one namespace
// PREFIX, as the half-open primary-key range `[prefix, prefixEnd(prefix))` — an
// index range scan (the explicit form of Dexie's `startsWith`; a LIKE prefix
// only uses the index under extra pragmas). The bound itself is db.ts's, beside
// the DDL that declares the key. Sync, unlike its siblings above: all three
// callers scan inside sync builders, and the expo driver is sync anyway.
//
// Rows come back RAW because the callers differ only in how they decode them —
// the read edge merges the path in (queries.ts `readNamespace` → `WithPath`),
// the backup keeps path and entity separate (export-all-data.ts
// `readRawNamespace`), and the import side reads the projected columns with no
// blob decode at all. Decoding belongs to each caller; the range belongs here.
export function namespaceRows(prefix: string): ItemRow[] {
  return getDb()
    .select()
    .from(items)
    .where(and(gte(items.path, prefix), lt(items.path, prefixEnd(prefix))))
    .all();
}

// The row + junction upsert, tx-taking — for callers that compose it into a LARGER
// transaction: the write edge in mutations.ts (which puts the record and enqueues
// its pending op atomically) and putItemsUnqueued below. The invariant is unchanged:
// junctions are written with their `items` row, replace-then-insert, from the same
// projected record.
export function putItemsTx(tx: DbTx, records: ItemRecord[]): void {
  for (const record of records) {
    const row = toRow(record);
    tx.insert(items).values(row).onConflictDoUpdate({ target: items.path, set: row }).run();
  }
  for (const paths of chunk(
    records.map((r) => r.path),
    IN_BATCH,
  )) {
    tx.delete(itemTagIds).where(inArray(itemTagIds.path, paths)).run();
    tx.delete(itemFacetStatuses).where(inArray(itemFacetStatuses.path, paths)).run();
  }
  const tagRows = records.flatMap(
    (r) => r.itemTagIds?.map((tagId) => ({ path: r.path, tagId })) ?? [],
  );
  for (const batch of chunk(tagRows, IN_BATCH)) tx.insert(itemTagIds).values(batch).run();
  const facetRows = records.flatMap(
    (r) => r.itemFacetStatuses?.map((token) => ({ path: r.path, token })) ?? [],
  );
  for (const batch of chunk(facetRows, IN_BATCH)) {
    tx.insert(itemFacetStatuses).values(batch).run();
  }
}

// Store PULLED records, skipping any path the queue holds an op for — the sync
// engine's download side, where "the server copy wins" is only true of paths this
// device hasn't edited. There is deliberately no UNGUARDED bulk put beside it: the
// only other writer is the local write edge, which goes through putItemsTx inside
// its own transaction (a local write overwrites whatever the queue says, by
// definition), so every path into this table is either guarded or the writer itself. The reconcile already filtered against the
// `pending` snapshot it read at the top of the cycle; this re-takes that test at
// write time, in the write's own transaction, because a local edit that landed
// mid-cycle is absent from that snapshot (pending-store's queuedPathsTx). Without
// it the server copy overwrites the edit AND the surviving pending op then uploads
// the server's bytes back — laundering the loss into a legitimate-looking commit.
//
// Returns the paths actually written, so a caller with a second, non-transactional
// half to do (the engine tearing down a content path's stale plaintext file) can
// apply it to exactly those.
export async function putItemsUnqueued(username: string, records: ItemRecord[]): Promise<string[]> {
  if (records.length === 0) return [];
  return getDb().transaction((tx) => {
    const queued = queuedPathsTx(
      tx,
      username,
      records.map((r) => r.path),
    );
    const writable = records.filter((r) => !queued.has(r.path));
    if (writable.length > 0) putItemsTx(tx, writable);
    return writable.map((r) => r.path);
  });
}

// Delete rows the pull judged gone server-side, skipping any path the queue holds
// an op for — putItemsUnqueued's counterpart, and the one that matters most: an
// unqueued delete of a path with a queued op leaves that op pointing at bytes that
// no longer exist, and nothing will ever put them back. The op then fails
// `no_object` on every commit, which by design requeues it — a queue stuck above
// zero that no sync can drain, and the record gone with it. A pending DELETE
// counts as an op too, so local-wins also stops the pull resurrecting a deletion
// that hasn't been pushed yet.
//
// Returns the paths actually deleted, for the caller's disk-file half.
export async function deleteItemsUnqueued(username: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  return getDb().transaction((tx) => {
    const queued = queuedPathsTx(tx, username, paths);
    const deletable = paths.filter((path) => !queued.has(path));
    if (deletable.length > 0) deleteItemsTx(tx, deletable);
    return deletable;
  });
}

// Stamp R2's authoritative `updatedAt` onto a batch of committed paths
// (sync/engine.ts commitBatched) — one transaction for the whole batch rather
// than a statement-per-path round trip through the driver. Each UPDATE is a
// no-op if its row is gone (a committed delete has no record left to stamp) —
// the same forgiveness as Dexie's `update`.
export async function stampItemUpdatedAts(
  stamps: { path: string; updatedAt: number }[],
): Promise<void> {
  if (stamps.length === 0) return;
  getDb().transaction((tx) => {
    for (const s of stamps) {
      tx.update(items).set({ updatedAt: s.updatedAt }).where(eq(items.path, s.path)).run();
    }
  });
}

// Flip a `files/` content row's materialization flag (db.ts `has_data_file`) —
// the engine's lazy-load path is the only writer, after the plaintext lands on
// disk. Same row-gone forgiveness as above.
export async function markItemDataFile(path: string, hasDataFile: boolean): Promise<void> {
  getDb().update(items).set({ hasDataFile }).where(eq(items.path, path)).run();
}

// The compare-and-set variant for the engine's lazy-load path: flip the flag only
// if the row still sits at the `updatedAt` the download started from. A sync pull
// can restamp the path mid-materialize (the re-stored row resets the flag and its
// disk file is torn down), and blindly marking it would pin the OLDER plaintext
// under the newer stamp — stale content served as current until the server moves
// again. Returns whether the flag was set; on false the caller owns the stale
// plaintext it just wrote (sync/engine.ts loadEntityContent).
export async function markItemDataFileIfCurrent(path: string, updatedAt: number): Promise<boolean> {
  const res = getDb()
    .update(items)
    .set({ hasDataFile: true })
    .where(and(eq(items.path, path), eq(items.updatedAt, updatedAt)))
    .run();
  return res.changes > 0;
}

// The row + junction delete, tx-taking — for callers that compose it into a LARGER
// transaction: the write edge in mutations.ts (which drops the record and enqueues
// its pending delete atomically) and deleteItemsUnqueued above, mirroring
// putItemsTx. The invariant is unchanged: junction rows go with their `items`
// row, in the same transaction.
export function deleteItemsTx(tx: DbTx, paths: string[]): void {
  for (const batch of chunk(paths, IN_BATCH)) {
    tx.delete(items).where(inArray(items.path, batch)).run();
    tx.delete(itemTagIds).where(inArray(itemTagIds.path, batch)).run();
    tx.delete(itemFacetStatuses).where(inArray(itemFacetStatuses.path, batch)).run();
  }
}

// One projection-only pass over the whole table: path → updatedAt with no `data`
// blob deserialized (only the two columns are selected, served by the covering
// `idx_items_updated_at` + rowid). Feeds both reconcile directions of the
// engine's fallback cycle — the expo analogue of web's IndexedDB key-cursor scan.
export async function listItemUpdatedAts(): Promise<Map<string, number>> {
  const rows = getDb().select({ path: items.path, updatedAt: items.updatedAt }).from(items).all();
  return new Map(rows.map((r) => [r.path, r.updatedAt]));
}
