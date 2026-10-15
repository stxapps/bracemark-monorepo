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
  return db.pendingOps.put(pendingDeleteRecord(username, path, baseUpdatedAt));
}

// The queue row a delete enqueues, without writing it — the delete-side twin of
// pendingPutRecord, for the BULK deleter (mutations.ts's bulkDeleteEntities). Same
// reason it exists: one `writeId` minting point, so a batched op can't quietly ship
// without one and re-acquire the blind-delete-by-path bug (db.ts).
export function pendingDeleteRecord(
  username: string,
  path: string,
  baseUpdatedAt: number,
): PendingOpRecord {
  return { username, path, op: 'delete', baseUpdatedAt, writeId: newId() };
}

// How many edits this account has queued and not yet pushed. A one-shot read for a
// caller that needs the number at a moment (the sign-out flow asks at the press);
// use-pending-changes-count.ts is the live version of the same query.
export function countPendingOps(username: string): Promise<number> {
  return db.pendingOps.where('username').equals(username).count();
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

// Take an account's WHOLE queue out, and hand back what was in it — the
// delete-all-data flow. While its server wipe is out, a cycle that starts (a
// timer, another edit) must find nothing to push, or it re-pushes ops past the
// wipe. But the wipe can still be refused or fail, and then the user is told
// nothing was removed, which is only true once the queue is back: hence take,
// not clear, and returnPendingOps below. One transaction, so an edit landing
// mid-take is either taken with the rest or queued after it.
export async function takePendingOps(username: string): Promise<PendingOpRecord[]> {
  return db.transaction('rw', db.pendingOps, async () => {
    const ops = await db.pendingOps.where('username').equals(username).toArray();
    await db.pendingOps.where('username').equals(username).delete();
    return ops;
  });
}

// Put back what takePendingOps took, after a delete that did not happen. A path
// edited since has a newer row, which supersedes the taken one and stays. Fenced
// on the account, like every write that can outlive its session
// (sync-store.ts): if the account was torn down meanwhile, its teardown has
// already cleared the queue, and these rows would be orphans keyed on a
// departed account — so they are dropped instead.
export async function returnPendingOps(username: string, ops: PendingOpRecord[]): Promise<void> {
  if (ops.length === 0) return;
  await db.transaction('rw', db.pendingOps, db.syncMeta, async () => {
    if (!(await db.syncMeta.get(username))) return;
    const keys = ops.map((o) => [o.username, o.path] as [string, string]);
    const current = await db.pendingOps.bulkGet(keys);
    const missing = ops.filter((_, i) => current[i] === undefined);
    if (missing.length > 0) await db.pendingOps.bulkAdd(missing);
  });
}
