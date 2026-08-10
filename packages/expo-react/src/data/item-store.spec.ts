// Store-level specs for the sync engine's local-wins guards, on the EXPO halves
// that genuinely differ from web's: `queuedPathsTx` composed into the write's own
// synchronous transaction (putItemsUnqueued / deleteItemsUnqueued), and
// clearDrainedOps' `WHERE write_id = ?` predicate evaluated inside the DELETE.
// web-react's engine.spec.ts is the canonical end-to-end coverage of the cycle
// (docs/local-first-sync.md — a sync cycle); these pin the divergent SQL, so they
// run against a REAL in-memory SQLite over the real DDL — a stubbed row scan
// would prove nothing about the predicates.
//
// `./db` is NOT mocked: `openDatabaseSync` is redirected to a node:sqlite shim
// (testing/node-sqlite.ts) so the real `getDb()` opens, sets its PRAGMA, and runs
// the real DDL, and every statement goes through the real drizzle expo driver —
// including the `Uint8Array` (not Buffer) blob typing the device gives back.

import { sql } from 'drizzle-orm';

import { utf8 } from '@stxapps/shared';

import { type DbTx, getDb } from './db';
import {
  bulkGetItems,
  deleteItemsUnqueued,
  getItem,
  markItemDataFile,
  markItemDataFileIfCurrent,
  putItemsTx,
  putItemsUnqueued,
  stampItemUpdatedAts,
} from './item-store';
import {
  clearDrainedOps,
  enqueueDeleteTx,
  enqueuePutTx,
  listPendingOps,
  type PendingOpRecord,
} from './pending-store';
import { toItemRecord } from './projection';

// The one seam that would reach native sqlite. Everything above it in db.ts —
// getDb, the PRAGMA, the DDL, the schema objects — runs for real.
jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
// Real-enough ids: UNIQUE per call, because `writeId` identity is the subject
// under test — a repeating stub would make compare-and-delete pass vacuously.
// (The real module lazily requires quick-crypto, which is native.)
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({
  newId: () => globalThis.crypto.randomUUID(),
}));

const USER = 'alice';
const LINK_PATH = 'links/l_a.enc';
const OTHER_PATH = 'links/l_b.enc';
const FILE_PATH = 'files/f_a.enc';

// The write edge's own shape (mutations.ts writeBytesWith): the record and its
// pending op land in ONE transaction — which is exactly the property the guards
// lean on. This is the driver's real transaction (drizzle issues
// begin/commit/rollback through the shim), not a stand-in for one.
function seedQueued(path: string, body: string, baseUpdatedAt = 0): void {
  getDb().transaction((tx) => {
    putItemsTx(tx, [toItemRecord(path, baseUpdatedAt, utf8(body))]);
    enqueuePutTx(tx, USER, path, baseUpdatedAt);
  });
}

function inTx(fn: (tx: DbTx) => void): void {
  getDb().transaction(fn);
}

function pendingOpsSorted(): Promise<PendingOpRecord[]> {
  return listPendingOps(USER).then((ops) => ops.sort((a, b) => a.path.localeCompare(b.path)));
}

// `getDb()` memoizes its connection, so the whole file shares one database (jest
// gives each spec FILE a fresh module registry). Truncate rather than reopen —
// and enumerate the tables from `sqlite_master` rather than a hand-kept list, so
// a table added to the DDL is cleared automatically instead of quietly leaking
// rows from one test into the next.
beforeEach(() => {
  const tables = getDb().all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const { name } of tables) getDb().run(sql.raw(`DELETE FROM "${name}"`));
});

describe('putItemsUnqueued', () => {
  it('writes unqueued paths and skips any path the queue holds an op for', async () => {
    seedQueued(LINK_PATH, 'my edit');

    const stored = await putItemsUnqueued(USER, [
      toItemRecord(LINK_PATH, 2000, utf8('server copy')),
      toItemRecord(OTHER_PATH, 2000, utf8('server only')),
    ]);

    expect(stored).toEqual([OTHER_PATH]);
    expect((await getItem(LINK_PATH))?.data).toStrictEqual(utf8('my edit'));
    expect((await getItem(OTHER_PATH))?.data).toStrictEqual(utf8('server only'));
  });

  it('skips a path whose queued op is a delete (no resurrection)', async () => {
    inTx((tx) => enqueueDeleteTx(tx, USER, LINK_PATH, 1000));

    const stored = await putItemsUnqueued(USER, [toItemRecord(LINK_PATH, 2000, utf8('back?'))]);

    expect(stored).toEqual([]);
    expect(await getItem(LINK_PATH)).toBeUndefined();
  });

  it('ignores another account’s queue', async () => {
    inTx((tx) => enqueuePutTx(tx, 'bob', LINK_PATH, 0));

    const stored = await putItemsUnqueued(USER, [toItemRecord(LINK_PATH, 2000, utf8('server'))]);

    expect(stored).toEqual([LINK_PATH]);
  });
});

describe('deleteItemsUnqueued', () => {
  it('deletes unqueued paths and spares any path with a queued op', async () => {
    seedQueued(LINK_PATH, 'unpushed create');
    inTx((tx) =>
      putItemsTx(tx, [toItemRecord(OTHER_PATH, 1000, utf8('synced, gone server-side'))]),
    );

    const deleted = await deleteItemsUnqueued(USER, [LINK_PATH, OTHER_PATH]);

    expect(deleted).toEqual([OTHER_PATH]);
    // The spared record still carries its queued op's payload.
    expect((await getItem(LINK_PATH))?.data).toStrictEqual(utf8('unpushed create'));
    expect(await getItem(OTHER_PATH)).toBeUndefined();
  });
});

describe('clearDrainedOps', () => {
  it('removes exactly the op rows the drain read', async () => {
    seedQueued(LINK_PATH, 'a');
    seedQueued(OTHER_PATH, 'b');
    const snapshot = await pendingOpsSorted();

    await clearDrainedOps([snapshot[0]]);

    const left = await pendingOpsSorted();
    expect(left.map((o) => o.path)).toEqual([OTHER_PATH]);
  });

  it('spares a row re-edited under a new writeId since the snapshot', async () => {
    seedQueued(LINK_PATH, 'first edit');
    const [snapshot] = await listPendingOps(USER);

    // The mid-push re-edit: same composite key, fresh writeId.
    seedQueued(LINK_PATH, 'second edit');
    await clearDrainedOps([snapshot]);

    const [survivor] = await listPendingOps(USER);
    expect(survivor.path).toBe(LINK_PATH);
    expect(survivor.writeId).not.toBe(snapshot.writeId);
  });

  it('spares a put→delete flip that landed since the snapshot', async () => {
    seedQueued(LINK_PATH, 'created');
    const [snapshot] = await listPendingOps(USER);

    inTx((tx) => enqueueDeleteTx(tx, USER, LINK_PATH, 0));
    await clearDrainedOps([snapshot]);

    const [survivor] = await listPendingOps(USER);
    expect(survivor.op).toBe('delete');
  });
});

describe('stampItemUpdatedAts', () => {
  it('restamps its rows and no-ops for missing ones', async () => {
    inTx((tx) => putItemsTx(tx, [toItemRecord(LINK_PATH, 1000, utf8('x'))]));

    await stampItemUpdatedAts([
      { path: LINK_PATH, updatedAt: 7777 },
      { path: 'links/gone.enc', updatedAt: 7777 },
    ]);

    expect((await getItem(LINK_PATH))?.updatedAt).toBe(7777);
    expect(await bulkGetItems(['links/gone.enc'])).toEqual([undefined]);
  });
});

describe('markItemDataFileIfCurrent', () => {
  it('sets the flag while the row still holds the stamp the fetch started from', async () => {
    inTx((tx) => putItemsTx(tx, [toItemRecord(FILE_PATH, 1000)]));

    expect(await markItemDataFileIfCurrent(FILE_PATH, 1000)).toBe(true);
    expect((await getItem(FILE_PATH))?.hasDataFile).toBeTruthy();
  });

  it('refuses when the row was restamped mid-fetch, leaving the flag unset', async () => {
    inTx((tx) => putItemsTx(tx, [toItemRecord(FILE_PATH, 1000)]));
    await markItemDataFile(FILE_PATH, false);
    // The mid-fetch sync pull: the row moves to the newer server version.
    await stampItemUpdatedAts([{ path: FILE_PATH, updatedAt: 2000 }]);

    expect(await markItemDataFileIfCurrent(FILE_PATH, 1000)).toBe(false);
    expect((await getItem(FILE_PATH))?.hasDataFile).toBeFalsy();
  });
});
