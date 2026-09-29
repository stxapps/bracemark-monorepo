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
  AccountFencedError,
  advanceCursor,
  beginInitialSync,
  claimIfStillSignedIn,
  getSyncMeta,
  isFirstSyncDone,
  markFirstSyncDone as markDone,
  resetCursor,
  seedNewAccount,
} from './sync-store';

// A first sync as the engine runs it: claim the row, then mark it done.
async function markFirstSyncDone(username: string, updatedAt: number, path: string) {
  await beginInitialSync(username);
  await markDone(username, updatedAt, path);
}

// The lifecycle half, stubbed: which account is persisted, and a lock that records
// whether a read ran inside it.
let mockPersisted: { username: string } | null = null;
let mockLockHeld = false;
let mockReadUnderLock: boolean[] = [];
jest.mock('./session-store', () => ({
  peekSession: () => {
    mockReadUnderLock.push(mockLockHeld);
    return Promise.resolve(mockPersisted);
  },
  withSessionLock: async (run: () => Promise<unknown>) => {
    mockLockHeld = true;
    try {
      return await run();
    } finally {
      mockLockHeld = false;
    }
  },
}));

const USER = 'alice';

beforeEach(async () => {
  await db.syncMeta.clear();
  mockPersisted = null;
  mockReadUnderLock = [];
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

// The account fence (sync-store.ts, AccountFencedError): a first sync claims its row
// before it writes anything, and finishing requires the row to still be there — a
// sign-out mid-pull must not come back as a "completed" store for an account that
// is no longer on the device.
describe('beginInitialSync / markFirstSyncDone', () => {
  it('claims a not-done row, so the gate keeps blocking until the pull finishes', async () => {
    await beginInitialSync(USER);

    expect(await getSyncMeta(USER)).toMatchObject({ firstSyncDoneAt: 0 });
    expect(await isFirstSyncDone(USER)).toBe(false);
  });

  it('leaves an existing row alone', async () => {
    await markFirstSyncDone(USER, 10, 'links/l_1.enc');

    await beginInitialSync(USER);

    expect(await isFirstSyncDone(USER)).toBe(true);
    expect(await cursor()).toEqual([10, 'links/l_1.enc']);
  });

  it('refuses to finish a pull whose account was torn down mid-way', async () => {
    await beginInitialSync(USER);
    await db.syncMeta.clear();

    await expect(markDone(USER, 10, 'links/l_1.enc')).rejects.toBeInstanceOf(AccountFencedError);
    expect(await getSyncMeta(USER)).toBeUndefined();
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

// The claim a sync may ask for — but only through the lifecycle lock, and only for
// the account still persisted. Asked for by a context that has not yet heard its
// account was torn down, it must not recreate the row the teardown dropped.
describe('claimIfStillSignedIn', () => {
  it('claims a not-done row while the account is still the persisted one', async () => {
    mockPersisted = { username: USER };

    await claimIfStillSignedIn(USER);

    expect(await getSyncMeta(USER)).toMatchObject({ firstSyncDoneAt: 0 });
  });

  it.each([
    ['no account', null],
    ['another account', { username: 'bob' }],
  ])('claims nothing once %s is persisted', async (_, persisted) => {
    mockPersisted = persisted;

    await claimIfStillSignedIn(USER);

    expect(await getSyncMeta(USER)).toBeUndefined();
  });

  it('reads the persisted account under the lifecycle lock', async () => {
    mockPersisted = { username: USER };
    mockLockHeld = false;

    await claimIfStillSignedIn(USER);

    expect(mockReadUnderLock).toEqual([true]);
  });
});
