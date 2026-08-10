'use client';

// Read/write helpers over the pending-ops queue (see db.ts `PendingOpRecord`). The UI
// enqueues here right after writing the local store; the sync engine drains here.
// Kept tiny and side-effect-light — no network, no React — so the queue has one
// owner, mirroring sync-store's ownership of the bookkeeping row.

import { newId } from '@stxapps/web-crypto';

import { db, type PendingOpRecord } from './db';

// Queue a create/edit for `path`. `baseUpdatedAt` is the path's stored server
// timestamp at edit time (0 for a brand-new file) — the base reconcile compares
// against. `put` replaces any existing entry for the same (account, path), so a
// re-edit before the drain collapses to one op (local last-writer-wins) — and the
// fresh `writeId` is what makes that replacement VISIBLE to a drain already in
// flight for the old one (db.ts, and clearDrainedOps below).
export function enqueuePut(
  username: string,
  path: string,
  baseUpdatedAt: number,
): Promise<[string, string]> {
  return db.pendingOps.put(pendingPutRecord(username, path, baseUpdatedAt));
}

// The queue row a put enqueues, without writing it — for the BULK writer
// (mutations.ts's bulkWriteEntities), which collects N rows and lands them in one
// `bulkPut` instead of N enqueuePut calls. Exists so that path shares this module's
// single `writeId` minting point rather than restating the row shape and quietly
// omitting it.
export function pendingPutRecord(
  username: string,
  path: string,
  baseUpdatedAt: number,
): PendingOpRecord {
  return { username, path, op: 'put', baseUpdatedAt, writeId: newId() };
}

// Queue a delete for `path`. The UI removes the local record itself; this only
// records the intent to delete the server object on the next drain. Overwrites a
// pending put for the same path (flip put→delete in place) — and, like a re-edit,
// takes a new `writeId` so an in-flight drain of that put can't clear the delete.
export function enqueueDelete(
  username: string,
  path: string,
  baseUpdatedAt: number,
): Promise<[string, string]> {
  return db.pendingOps.put({ username, path, op: 'delete', baseUpdatedAt, writeId: newId() });
}

// The full queue for an account, in no particular order — the engine imposes its
// own meta-last ordering at push time, so insertion order doesn't matter here.
export function listPendingOps(username: string): Promise<PendingOpRecord[]> {
  return db.pendingOps.where('username').equals(username).toArray();
}

// Drop the ops a drain finished with — called after a commit returns them in
// `results` (an op left out, e.g. a `no_object` failure, stays queued for the next
// drain), and for an op the drain found unsatisfiable.
//
// COMPARE-AND-DELETE on `writeId`, never a blind delete by path: the caller hands
// back the op ROWS it read at the top of its cycle, and a row is removed only if the
// queue still holds that same write. A local edit made during the push replaced the
// row (same primary key, new `writeId`), and it must survive — the cycle uploaded the
// bytes of the edit BEFORE it, so deleting the newer row would strand a change in the
// local store with nothing queued to carry it. See db.ts `writeId`.
//
// The read and the delete share one transaction, so an edit landing mid-clear is
// ordered either before it (its row is seen, and kept) or after it (its put re-creates
// the row) — the same rule the engine's applyDeletes / putPulled follow.
export async function clearDrainedOps(ops: PendingOpRecord[]): Promise<void> {
  if (ops.length === 0) return;
  await db.transaction('rw', db.pendingOps, async () => {
    const keys = ops.map((o) => [o.username, o.path] as [string, string]);
    const current = await db.pendingOps.bulkGet(keys);
    const drained = keys.filter((_, i) => current[i]?.writeId === ops[i].writeId);
    if (drained.length > 0) await db.pendingOps.bulkDelete(drained);
  });
}

// Drop an account's WHOLE queue — the delete-all-data flow, which abandons
// every unsynced local change on purpose (the user is deleting everything, so
// pushing them first would be wasted work the wipe immediately undoes).
export async function clearPendingOps(username: string): Promise<void> {
  await db.pendingOps.where('username').equals(username).delete();
}
