// Specs for the pending-ops queue's two non-obvious rules — the ones whose violation
// loses a user's edit with no error, no retry and no pending count to notice it by:
//
//   1. an enqueue COLLAPSES to one row per (account, path) under a FRESH `writeId`, and
//   2. `clearDrainedOps` is a COMPARE-AND-DELETE on that `writeId`, never a blind delete
//      by path.
//
// Together they cover the write-during-push window: a cycle reads the queue, uploads the
// bytes it saw, and only then clears — so an edit that landed while those bytes were in
// flight must still be queued afterward. The bug this prevents (db.ts `writeId`) leaves
// the local store holding a change with nothing queued to carry it: the UI shows the
// edit, "0 changes waiting" is honest about the queue, and the change simply never
// reaches another device.
//
// web-react's engine.spec.ts is canonical for the CYCLE; this pins the store rule the
// cycle leans on, in the terms the store itself can be wrong in. The expo sibling
// evaluates the same predicate inside a SQL DELETE rather than a read-then-filter, which
// is why it has its own coverage (expo-react data/item-store.spec.ts).

import { LINKS_PREFIX, pathFromId } from '@stxapps/shared';

import { db, type PendingOpRecord } from './db';
import {
  clearDrainedOps,
  clearPendingOps,
  enqueueDelete,
  enqueuePut,
  listPendingOps,
  pendingDeleteRecord,
  pendingPutRecord,
} from './pending-store';

const USER = 'alice';
const OTHER = 'bob';
const PATH = pathFromId('l_1', LINKS_PREFIX);
const OTHER_PATH = pathFromId('l_2', LINKS_PREFIX);

beforeEach(async () => {
  await db.pendingOps.clear();
});

const rowFor = async (username: string, path: string): Promise<PendingOpRecord | undefined> =>
  db.pendingOps.get([username, path]);

describe('enqueue', () => {
  // Local last-writer-wins: two edits before a drain are one upload, not two.
  it('collapses repeated edits of one path into a single row', async () => {
    await enqueuePut(USER, PATH, 0);
    await enqueuePut(USER, PATH, 0);

    expect(await listPendingOps(USER)).toHaveLength(1);
  });

  // The collapse is only SAFE because the replacement is visible to a drain already in
  // flight for the row it replaced — which is what the fresh writeId is for. A stable id
  // would make every compare-and-delete below pass vacuously.
  it('mints a fresh writeId on every enqueue, so a replacement is distinguishable', async () => {
    await enqueuePut(USER, PATH, 0);
    const first = await rowFor(USER, PATH);
    await enqueuePut(USER, PATH, 0);
    const second = await rowFor(USER, PATH);

    expect(second?.writeId).not.toBe(first?.writeId);
  });

  // A delete after a queued put is the same path's op flipped in place — the server
  // object is going away, so uploading the superseded bytes first would be wasted work.
  it('flips a queued put to a delete in place', async () => {
    await enqueuePut(USER, PATH, 5);
    await enqueueDelete(USER, PATH, 5);

    const ops = await listPendingOps(USER);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('delete');
  });

  // The queue is keyed on (account, path): two accounts on one device queue
  // independently, and a drain scoped to one must not see the other's work.
  it('keeps two accounts’ queues separate', async () => {
    await enqueuePut(USER, PATH, 0);
    await enqueuePut(OTHER, PATH, 0);

    expect(await listPendingOps(USER)).toHaveLength(1);
    expect(await listPendingOps(OTHER)).toHaveLength(1);
  });

  // The bulk writers (mutations.ts) build rows without writing them, so they can land N
  // in one bulkPut. They exist to share this module's ONE writeId minting point — a
  // batched op that shipped without one would silently re-acquire the blind-delete bug.
  it('gives the row builders the same fresh-writeId guarantee as the writers', () => {
    const put = pendingPutRecord(USER, PATH, 0);
    const del = pendingDeleteRecord(USER, PATH, 0);

    expect(put.writeId).toBeTruthy();
    expect(del.writeId).toBeTruthy();
    expect(put.writeId).not.toBe(del.writeId);
    expect(pendingPutRecord(USER, PATH, 0).writeId).not.toBe(put.writeId);
  });

  // `baseUpdatedAt` is the reconcile base the push compares against — 0 means "no server
  // object yet", which is how a create is told apart from an edit.
  it('records the reconcile base the caller edited against', async () => {
    await enqueuePut(USER, PATH, 1_700_000_000_000);

    expect((await rowFor(USER, PATH))?.baseUpdatedAt).toBe(1_700_000_000_000);
  });
});

describe('clearDrainedOps', () => {
  it('removes the ops a drain actually finished with', async () => {
    await enqueuePut(USER, PATH, 0);
    await enqueuePut(USER, OTHER_PATH, 0);
    const drained = await listPendingOps(USER);

    await clearDrainedOps(drained);

    expect(await listPendingOps(USER)).toEqual([]);
  });

  // THE ONE THAT MATTERS. The cycle uploaded the bytes of the edit BEFORE this one, so
  // the newer row has to survive — deleting it strands the change in the local store
  // with nothing queued to carry it, and nothing anywhere reports that.
  it('spares a row replaced by an edit that landed during the push', async () => {
    await enqueuePut(USER, PATH, 0);
    const inFlight = await listPendingOps(USER);

    // ... the user edits the same link while the push is in flight.
    await enqueuePut(USER, PATH, 0);

    await clearDrainedOps(inFlight);

    const remaining = await listPendingOps(USER);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].writeId).not.toBe(inFlight[0].writeId);
  });

  // Same window, the sharper shape: a DELETE queued mid-push must not be cleared by the
  // put's drain, or the server object outlives the local deletion forever.
  it('spares a delete queued over a put that was being pushed', async () => {
    await enqueuePut(USER, PATH, 0);
    const inFlight = await listPendingOps(USER);

    await enqueueDelete(USER, PATH, 0);
    await clearDrainedOps(inFlight);

    const remaining = await listPendingOps(USER);
    expect(remaining.map((op) => op.op)).toEqual(['delete']);
  });

  // Partial commits are normal (a `no_object` failure leaves an op out of `results`), so
  // clearing must be per-row, not per-batch.
  it('clears only the ops handed back, leaving the rest queued', async () => {
    await enqueuePut(USER, PATH, 0);
    await enqueuePut(USER, OTHER_PATH, 0);
    const [first] = await listPendingOps(USER);

    await clearDrainedOps([first]);

    const remaining = await listPendingOps(USER);
    expect(remaining.map((op) => op.path)).toEqual([
      [PATH, OTHER_PATH].find((path) => path !== first.path),
    ]);
  });

  it('is a no-op for an empty batch', async () => {
    await enqueuePut(USER, PATH, 0);

    await clearDrainedOps([]);

    expect(await listPendingOps(USER)).toHaveLength(1);
  });
});

describe('clearPendingOps', () => {
  // The delete-all-data flow abandons this account's unsynced work on purpose — but it
  // is one account being deleted, not the device.
  it('abandons one account’s whole queue and leaves the other account’s alone', async () => {
    await enqueuePut(USER, PATH, 0);
    await enqueueDelete(USER, OTHER_PATH, 1);
    await enqueuePut(OTHER, PATH, 0);

    await clearPendingOps(USER);

    expect(await listPendingOps(USER)).toEqual([]);
    expect(await listPendingOps(OTHER)).toHaveLength(1);
  });
});
