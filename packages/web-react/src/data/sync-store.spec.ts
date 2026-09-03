// Specs for the sync bookkeeping row — the seam that owns the gate invariant
// "firstSyncDoneAt > 0 ⇒ the local store is complete up to the cursor" (sync-store.ts).
//
// Two rules here are silent when broken, and they pull in OPPOSITE directions, which is
// exactly why both need pinning:
//
//   - `advanceCursor` is FORWARD-ONLY over the compound `(updatedAt, path)` key. A
//     slower tab finishing late must not drag the cursor back below what a faster one
//     already consumed. Getting the compound comparison wrong (comparing only the
//     millisecond, or comparing the path first) produces a plausible cursor, never an
//     error — the next pull just re-reads or, worse, skips.
//   - `resetCursor` is UNCONDITIONAL, because the download-authoritative fallback exists
//     precisely to LOWER a stale cursor back to what R2 actually holds. If it ever grew
//     the forward-only guard "for consistency", the cursor-ahead recovery stops
//     recovering and the device silently stalls on a cursor the server has never heard of.
//
// The engine-level meaning of these calls is covered by sync/engine.spec.ts; this pins
// the store's own arithmetic, in the terms it can be wrong in.

import { db } from './db';
import {
  advanceCursor,
  getSyncMeta,
  isFirstSyncDone,
  markFirstSyncDone,
  resetCursor,
  seedNewAccount,
} from './sync-store';

const USER = 'alice';

beforeEach(async () => {
  await db.syncMeta.clear();
});

const cursor = async () => {
  const meta = await getSyncMeta(USER);
  return [meta?.syncCursorUpdatedAt, meta?.syncCursorPath];
};

describe('isFirstSyncDone', () => {
  // A device that has never synced this account has no row at all — and "no row" has to
  // read as not-done, or InitialSyncGate renders an empty library as if it were complete.
  it('is false when this device has no row for the account', async () => {
    expect(await isFirstSyncDone(USER)).toBe(false);
  });

  // An interrupted first sync leaves the row present but the flag at 0 — it must
  // re-block on the next load rather than showing a partial store as finished.
  it('is false for a row whose first sync never completed', async () => {
    await db.syncMeta.put({
      username: USER,
      syncCursorUpdatedAt: 0,
      syncCursorPath: '',
      firstSyncDoneAt: 0,
    });

    expect(await isFirstSyncDone(USER)).toBe(false);
  });

  it('is true once the first sync has been marked done', async () => {
    await markFirstSyncDone(USER, 10, 'links/l_1.enc');

    expect(await isFirstSyncDone(USER)).toBe(true);
  });
});

describe('seedNewAccount', () => {
  // A brand-new account is empty by definition, so an empty local store IS the complete
  // snapshot — that is what lets create-account render instantly with no round trip.
  it('marks the first sync done at an empty cursor, with no network involved', async () => {
    await seedNewAccount(USER);

    expect(await isFirstSyncDone(USER)).toBe(true);
    expect(await cursor()).toEqual([0, '']);
  });
});

describe('advanceCursor', () => {
  beforeEach(async () => {
    await markFirstSyncDone(USER, 100, 'links/l_b.enc');
  });

  it('moves the cursor forward on a later timestamp', async () => {
    await advanceCursor(USER, 200, 'links/l_a.enc');

    expect(await cursor()).toEqual([200, 'links/l_a.enc']);
  });

  it('refuses to move the cursor backwards', async () => {
    await advanceCursor(USER, 50, 'links/l_z.enc');

    expect(await cursor()).toEqual([100, 'links/l_b.enc']);
  });

  // The compound half: within one millisecond the PATH breaks the tie, so two ops
  // stamped identically still have a total order. Ignoring the path here makes the
  // cursor stick and the same op re-pull forever.
  it('breaks a same-millisecond tie on the path, forwards', async () => {
    await advanceCursor(USER, 100, 'links/l_c.enc');

    expect(await cursor()).toEqual([100, 'links/l_c.enc']);
  });

  it('breaks a same-millisecond tie on the path, backwards', async () => {
    await advanceCursor(USER, 100, 'links/l_a.enc');

    expect(await cursor()).toEqual([100, 'links/l_b.enc']);
  });

  // A LATER millisecond resets the tiebreak: both halves move together, so a path that
  // sorts earlier is still ahead when its timestamp is newer. Comparing the path first
  // (or comparing the pair lexicographically as strings) fails exactly here.
  it('accepts an earlier-sorting path when the timestamp is newer', async () => {
    await advanceCursor(USER, 300, 'links/l_a.enc');

    expect(await cursor()).toEqual([300, 'links/l_a.enc']);
  });

  it('leaves firstSyncDoneAt untouched', async () => {
    const before = (await getSyncMeta(USER))?.firstSyncDoneAt;

    await advanceCursor(USER, 400, 'links/l_z.enc');

    expect((await getSyncMeta(USER))?.firstSyncDoneAt).toBe(before);
  });

  // Signed out mid-cycle: the row is gone, and a late cycle must not resurrect it — a
  // recreated row would claim the first sync is done for a store that was just wiped.
  it('does not recreate a row that a sign-out removed mid-cycle', async () => {
    await db.syncMeta.clear();

    await advanceCursor(USER, 400, 'links/l_z.enc');

    expect(await getSyncMeta(USER)).toBeUndefined();
  });
});

describe('resetCursor', () => {
  // The whole point of the fallback: R2's listing is authoritative, so a cursor ahead of
  // what R2 holds must come DOWN. This is the one call that may move backwards.
  it('lowers a cursor that has run ahead of what R2 actually holds', async () => {
    await markFirstSyncDone(USER, 500, 'links/l_z.enc');

    await resetCursor(USER, 100, 'links/l_a.enc');

    expect(await cursor()).toEqual([100, 'links/l_a.enc']);
  });

  it('leaves firstSyncDoneAt untouched', async () => {
    await markFirstSyncDone(USER, 500, 'links/l_z.enc');
    const before = (await getSyncMeta(USER))?.firstSyncDoneAt;

    await resetCursor(USER, 1, 'links/l_a.enc');

    expect((await getSyncMeta(USER))?.firstSyncDoneAt).toBe(before);
  });
});
