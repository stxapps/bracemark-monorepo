// Specs for the expo lock rows. The API mirrors web's so the lock-provider port is
// drop-in — which is exactly the risk: this store has a NULLABLE-column layer web doesn't,
// and the shared lock logic (`computeCoverage`) reads `hideList` as an OPTIONAL boolean,
// never as `null`. So `putLock` maps `undefined → null` on the way in and `readLocks` maps
// `null → undefined` on the way out, and if either half stops, a `hideList: null` reaches
// the shared code where `undefined` was promised.
//
// That is silent in the direction that matters: `null` is falsy, so a lock that should
// hide its list simply… doesn't, and the list stays visible in the sidebar with its links
// gated — which reads as a bug in the sidebar, not in a column mapping. The `biometric`
// column has the same shape and the same round trip.
//
// Real sqlite through the node:sqlite shim: the mapping only exists because of the
// columns, so a stubbed store would assert nothing.

import { sql } from 'drizzle-orm';

import { getDb } from './db';
import { APP_LOCK_ID, deleteLock, type LockRecord, putLock, readLocks } from './lock-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));

const APP: LockRecord = { id: APP_LOCK_ID, kind: 'app', salt: 'aa', hash: 'bb' };

beforeEach(() => {
  getDb().run(sql`DELETE FROM locks`);
});

describe('readLocks', () => {
  it('is empty on a device with no locks', async () => {
    expect(await readLocks()).toEqual([]);
  });

  // THE MAPPING. `computeCoverage` and the provider both read `hideList` as an optional
  // boolean; a `null` arriving there is falsy, so the failure is a list that quietly stops
  // hiding rather than anything that throws.
  it('hands back optional flags as undefined, never as null', async () => {
    await putLock(APP);

    const [row] = await readLocks();
    expect(row.hideList).toBeUndefined();
    expect(row.biometric).toBeUndefined();
    expect('hideList' in row).toBe(true);
  });

  it('round-trips the flags that were set', async () => {
    await putLock({
      id: 'li_1',
      kind: 'list',
      salt: 's',
      hash: 'h',
      hideList: true,
      biometric: true,
    });

    expect(await readLocks()).toEqual([
      { id: 'li_1', kind: 'list', salt: 's', hash: 'h', hideList: true, biometric: true },
    ]);
  });

  // `false` is a decision, not an absence: a user who turned hiding OFF must not read back
  // as "never chose", which is what an `undefined` here would mean to the settings UI.
  it('keeps an explicit false distinct from an unset flag', async () => {
    await putLock({ id: 'li_1', kind: 'list', salt: 's', hash: 'h', hideList: false });

    expect((await readLocks())[0].hideList).toBe(false);
  });
});

describe('putLock', () => {
  // One row per lock id: re-locking a list with a new password replaces the verifier
  // rather than leaving two rows, one of which would still open with the old password.
  it('replaces an existing lock rather than adding a second row', async () => {
    await putLock({ id: 'li_1', kind: 'list', salt: 'old', hash: 'old' });
    await putLock({ id: 'li_1', kind: 'list', salt: 'new', hash: 'new' });

    const rows = await readLocks();
    expect(rows).toHaveLength(1);
    expect(rows[0].salt).toBe('new');
  });

  // The app lock and a list lock share one table; list locks are keyed by list id, and no
  // system-list constant or random token can collide with APP_LOCK_ID.
  it('keeps the app lock and list locks side by side', async () => {
    await putLock(APP);
    await putLock({ id: 'li_1', kind: 'list', salt: 's', hash: 'h' });

    expect((await readLocks()).map((row) => row.kind).sort()).toEqual(['app', 'list']);
  });
});

describe('deleteLock', () => {
  it('removes one lock and leaves the others', async () => {
    await putLock(APP);
    await putLock({ id: 'li_1', kind: 'list', salt: 's', hash: 'h' });

    await deleteLock('li_1');

    expect((await readLocks()).map((row) => row.id)).toEqual([APP_LOCK_ID]);
  });

  // The orphan sweep deletes locks whose lists are gone, and two devices can reach the
  // same row — so deleting an absent lock has to be a no-op, not an error.
  it('is a no-op for a lock that is already gone', async () => {
    await expect(deleteLock('never-existed')).resolves.toBeUndefined();
  });
});
