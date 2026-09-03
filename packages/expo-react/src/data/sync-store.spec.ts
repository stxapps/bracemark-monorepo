// A DRIFT GUARD for the expo sync bookkeeping row. web-react's sync-store.spec.ts is
// canonical for what these operations mean; the two stores are duplicated source over
// different engines (Dexie's zone-scoped transaction there, drizzle's synchronous
// transaction callback here), so a spec passing on web's copy proves nothing about this
// one — edit this comparison and nothing in the workspace fails.
//
// What is pinned is the pair that pulls in opposite directions, because both are silent:
//
//   - `advanceCursor` is FORWARD-ONLY over the compound `(updatedAt, path)` key, with the
//     path breaking a same-millisecond tie. Getting the comparison wrong yields a
//     plausible cursor, never an error: the next pull just re-reads, or skips.
//   - `resetCursor` is UNCONDITIONAL, because the download-authoritative fallback exists
//     precisely to LOWER a stale cursor back to what R2 holds. Grow it the forward-only
//     guard "for consistency" and the cursor-ahead recovery stops recovering — the device
//     stalls on a cursor the server never had.
//
// Real sqlite: `openDatabaseSync` is redirected to the node:sqlite shim, so `getDb()`
// opens for real, runs the real DDL, and every statement goes through the real drizzle
// expo driver — which is where a transaction-shaped bug would live.

import { sql } from 'drizzle-orm';

import { getDb } from './db';
import {
  advanceCursor,
  getSyncMeta,
  isFirstSyncDone,
  markFirstSyncDone,
  resetCursor,
  seedNewAccount,
} from './sync-store';

// The one seam that would reach native sqlite. Everything above it — getDb, the PRAGMA,
// the DDL, the schema objects — runs for real.
jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));

const USER = 'alice';

beforeEach(() => {
  getDb().run(sql`DELETE FROM sync_meta`);
});

const cursor = async () => {
  const meta = await getSyncMeta(USER);
  return [meta?.syncCursorUpdatedAt, meta?.syncCursorPath];
};

describe('isFirstSyncDone', () => {
  // No row means the gate must BLOCK on a full pull — reporting done would render an
  // empty library as though it were the complete account.
  it('is false when this device has no row for the account', async () => {
    expect(await isFirstSyncDone(USER)).toBe(false);
  });

  it('is true once the first sync has been marked done', async () => {
    await markFirstSyncDone(USER, 10, 'links/l_1.enc');

    expect(await isFirstSyncDone(USER)).toBe(true);
  });
});

describe('seedNewAccount', () => {
  // A brand-new account is empty by definition, so an empty local store IS the complete
  // snapshot — what lets create-account render instantly with no round trip.
  it('marks the first sync done at an empty cursor', async () => {
    await seedNewAccount(USER);

    expect(await isFirstSyncDone(USER)).toBe(true);
    expect(await cursor()).toEqual([0, '']);
  });

  // Also the delete-all-data reset, which runs against an EXISTING row — so the upsert
  // has to overwrite rather than conflict.
  it('resets an existing row rather than failing on the conflict', async () => {
    await markFirstSyncDone(USER, 500, 'links/l_z.enc');

    await seedNewAccount(USER);

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

  // The compound half: within one millisecond the PATH is the tiebreak, so two ops stamped
  // identically still have a total order. Drop it and the cursor sticks, re-pulling the
  // same op forever.
  it('breaks a same-millisecond tie on the path, forwards', async () => {
    await advanceCursor(USER, 100, 'links/l_c.enc');

    expect(await cursor()).toEqual([100, 'links/l_c.enc']);
  });

  it('breaks a same-millisecond tie on the path, backwards', async () => {
    await advanceCursor(USER, 100, 'links/l_a.enc');

    expect(await cursor()).toEqual([100, 'links/l_b.enc']);
  });

  // A LATER millisecond resets the tiebreak — comparing the path first, or the pair as one
  // string, fails exactly here.
  it('accepts an earlier-sorting path when the timestamp is newer', async () => {
    await advanceCursor(USER, 300, 'links/l_a.enc');

    expect(await cursor()).toEqual([300, 'links/l_a.enc']);
  });

  it('leaves firstSyncDoneAt untouched', async () => {
    const before = (await getSyncMeta(USER))?.firstSyncDoneAt;

    await advanceCursor(USER, 400, 'links/l_z.enc');

    expect((await getSyncMeta(USER))?.firstSyncDoneAt).toBe(before);
  });

  // Signed out mid-cycle: a late cycle must not RESURRECT the row, which would claim the
  // first sync is done for a store that was just wiped.
  it('does not recreate a row that a sign-out removed mid-cycle', async () => {
    getDb().run(sql`DELETE FROM sync_meta`);

    await advanceCursor(USER, 400, 'links/l_z.enc');

    expect(await getSyncMeta(USER)).toBeUndefined();
  });
});

describe('resetCursor', () => {
  // The whole point of the fallback: R2's listing is authoritative, so a cursor ahead of
  // what R2 holds has to come DOWN. The one call that may move backwards.
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
