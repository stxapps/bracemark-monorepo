// Read/write helpers over the pending-ops queue — the expo sibling of
// web-react's data/pending-store.ts, same API (see there for the queue's full
// semantics: the UI enqueues right after writing the local store, the sync
// engine drains, removal only on a commit's `results`). Kept tiny and
// side-effect-light — no network, no React — so the queue has one owner,
// mirroring sync-store's ownership of the bookkeeping row.

import { and, count, eq, inArray } from 'drizzle-orm';

// Deep import, not the package barrel: the barrel executes the AES + Argon2 stack
// (react-native-quick-crypto, readable-stream, buffer) — docs/share-sheet.md, _the
// rule is: name a FILE, never a barrel_. `newId`'s own quick-crypto require is lazy,
// so importing it costs nothing until an enqueue actually runs.
import { newId } from '@stxapps/expo-crypto/lib/ids';
import { chunk } from '@stxapps/shared';

import { type DbTx, getDb, pendingOps } from './db';

// Same shape as web-react's PendingOpRecord (every column NOT NULL, so the
// drizzle-inferred row already matches it exactly).
export type PendingOpRecord = typeof pendingOps.$inferSelect;

// Keep `IN (...)` lists under SQLite's bound-variable ceiling — item-store.ts's
// constant, restated rather than shared so neither store has to import the other
// for a number.
const IN_BATCH = 500;

// The upsert: the composite (username, path) key makes a re-edit before the
// drain collapse to one op (local last-writer-wins), and a pending put can flip
// to delete in place — each time under a FRESH `writeId`, which is what makes
// that collapse visible to a drain already in flight for the row it replaced
// (db.ts `writeId`, clearDrainedOps below). Minted here, in the one place every
// enqueue passes through. Takes the transaction handle so it rides the caller's
// transaction — unlike web-react's ambient (zone-scoped) Dexie transactions,
// expo-sqlite/drizzle has no ambient tx, so a write only participates in the
// caller's transaction if it goes through that tx handle. This is why there is
// NO non-tx enqueue: every enqueue is paired with a local-store put in ONE
// transaction (mutations.ts), so a bare getDb() insert would silently write the
// queue outside that atomicity.
function enqueue(tx: DbTx, record: PendingOpRecord): void {
  tx.insert(pendingOps)
    .values(record)
    .onConflictDoUpdate({ target: [pendingOps.username, pendingOps.path], set: record })
    .run();
}

// Queue a create/edit for `path`, in the caller's transaction — for the write
// edge (mutations.ts), which must enqueue in the SAME transaction as the
// local-store put so the store and the durable queue can never disagree about
// whether an edit happened. `baseUpdatedAt` is the path's stored server
// timestamp at edit time (0 for a brand-new file) — the base reconcile compares
// against.
export function enqueuePutTx(
  tx: DbTx,
  username: string,
  path: string,
  baseUpdatedAt: number,
): void {
  enqueue(tx, { username, path, op: 'put', baseUpdatedAt, writeId: newId() });
}

// Queue a delete for `path`, in the caller's transaction — the delete-edge
// sibling of enqueuePutTx (mutations.ts's future deleteEntity port). The UI
// drops the local record in the SAME transaction; this only records the intent
// to delete the server object on the next drain. `baseUpdatedAt` is the path's
// stored server timestamp, the reconcile base exactly as on the put path.
export function enqueueDeleteTx(
  tx: DbTx,
  username: string,
  path: string,
  baseUpdatedAt: number,
): void {
  enqueue(tx, { username, path, op: 'delete', baseUpdatedAt, writeId: newId() });
}

// The full queue for an account, in no particular order — the engine imposes its
// own meta-last ordering at push time, so insertion order doesn't matter here.
export async function listPendingOps(username: string): Promise<PendingOpRecord[]> {
  return getDb().select().from(pendingOps).where(eq(pendingOps.username, username)).all();
}

// Which of `paths` the queue currently holds an op for — the LOCAL-WINS test, and
// the one read the engine must take at APPLY time rather than trusting the
// `pending` snapshot from the top of its cycle. A cycle is many round trips long
// and this device keeps writing through it, so a create that landed mid-cycle is
// absent from that snapshot; without this re-read the pull deletes it (fallback's
// "local only, not queued" row) or overwrites it with the server copy, and its
// pending op — written in the same transaction — is left pointing at nothing.
// See item-store's putItemsUnqueued / deleteItemsUnqueued, which compose it, and
// docs/local-first-sync.md, _a sync cycle_.
//
// Tx-taking on purpose: the answer is only sound if the write it guards is in the
// SAME transaction (there is no ambient tx here — see enqueue above). The
// transaction callback is synchronous, so no local write can interleave between
// this read and that write.
export function queuedPathsTx(tx: DbTx, username: string, paths: string[]): Set<string> {
  const queued = new Set<string>();
  for (const batch of chunk(paths, IN_BATCH)) {
    const rows = tx
      .select({ path: pendingOps.path })
      .from(pendingOps)
      .where(and(eq(pendingOps.username, username), inArray(pendingOps.path, batch)))
      .all();
    for (const row of rows) queued.add(row.path);
  }
  return queued;
}

// How many ops are queued for an account — the "N changes waiting to sync"
// status line (use-pending-changes-count). A plain SQL count, no row decode.
export async function countPendingOps(username: string): Promise<number> {
  const row = getDb()
    .select({ n: count() })
    .from(pendingOps)
    .where(eq(pendingOps.username, username))
    .get();
  return row?.n ?? 0;
}

// Drop the ops a drain finished with — called after a commit returns them in
// `results` (an op left out, e.g. a `no_object` failure, stays queued for the
// next drain), and for an op the drain found unsatisfiable.
//
// COMPARE-AND-DELETE on `writeId`, never a blind delete by path: the caller hands
// back the op ROWS it read at the top of its cycle, and a row is removed only if
// the queue still holds that same write. An edit made DURING the push replaced
// the row (same composite key, new `writeId`) and must survive — the drain
// uploaded the bytes of the edit before it, so deleting the newer row would
// strand a change in the local store with nothing queued to carry it. That
// failure is silent: no error, no pending count, no retry (web-react
// pending-store.ts, docs/local-first-sync.md — _a sync cycle_).
//
// One statement per op rather than an `inArray` sweep, because the predicate is
// per-row; wrapped in a transaction so the batch still lands atomically. Unlike
// web's Dexie port there is no read-then-filter step: sqlite evaluates the
// `write_id` match INSIDE the DELETE, and the transaction callback is
// synchronous, so nothing can interleave between the test and the delete.
export async function clearDrainedOps(ops: PendingOpRecord[]): Promise<void> {
  if (ops.length === 0) return;
  getDb().transaction((tx) => {
    for (const op of ops) {
      tx.delete(pendingOps)
        .where(
          and(
            eq(pendingOps.username, op.username),
            eq(pendingOps.path, op.path),
            eq(pendingOps.writeId, op.writeId),
          ),
        )
        .run();
    }
  });
}

// Drop an account's WHOLE queue — the delete-all-data flow, which abandons
// every unsynced local change on purpose (the user is deleting everything, so
// pushing them first would be wasted work the wipe immediately undoes).
export async function clearPendingOps(username: string): Promise<void> {
  getDb().delete(pendingOps).where(eq(pendingOps.username, username)).run();
}
