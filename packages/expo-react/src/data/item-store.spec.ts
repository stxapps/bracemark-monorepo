// Store-level specs for the sync engine's local-wins guards, on the EXPO halves
// that genuinely differ from web's: `queuedPathsTx` composed into the write's own
// synchronous transaction (putItemsUnqueued / deleteItemsUnqueued), and
// clearDrainedOps' `(username, path, write_id) IN (VALUES …)` predicate evaluated
// inside the DELETE, and stampItemUpdatedAts' `UPDATE … FROM (VALUES …)`, and
// getItemForOp's row read paired with the queue row's `write_id` in one
// transaction.
// web-react's engine.spec.ts is the canonical end-to-end coverage of the cycle
// (docs/local-first-sync.md — a sync cycle); these pin the divergent SQL, so they
// run against a REAL in-memory SQLite over the real DDL — a stubbed row scan
// would prove nothing about the predicates. The engine-level half of the same
// split — what those guards mean once a `files/` plaintext file hangs off the
// row they spare — is ../sync/engine.spec.ts (docs/testing.md, _the ported
// pair_).
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
  getItemForOp,
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
import { seedNewAccount } from './sync-store';

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
  // A signed-in account owns the store: pulled writes are fenced on its
  // bookkeeping row (sync-store.ts, AccountFencedError).
  void seedNewAccount(USER);
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

  // Set-at-a-time: the triples go out in several DELETEs of one transaction, so a
  // drain bigger than one statement's batch has to clear every op past the first
  // batch too, and still spare a re-edit that sits in a later one.
  it('clears a drain spanning several statements, sparing a re-edit among them', async () => {
    const paths = Array.from(
      { length: 400 },
      (_, i) => `links/l_${String(i).padStart(3, '0')}.enc`,
    );
    for (const path of paths) seedQueued(path, 'x');
    const snapshot = await pendingOpsSorted();

    seedQueued(paths[300], 'edited mid-push');
    await clearDrainedOps(snapshot);

    const left = await pendingOpsSorted();
    expect(left.map((o) => o.path)).toEqual([paths[300]]);
    expect(left[0].writeId).not.toBe(snapshot[300].writeId);
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

// The upload side's read. A drain holds the op rows it read at the top of its
// cycle and reads each record only when that op's upload starts; this is what
// tells it whether the record is still the write its op stands for.
describe('getItemForOp', () => {
  it('returns the row with the op that is still queued for it', async () => {
    seedQueued(LINK_PATH, 'the edit');
    const [op] = await listPendingOps(USER);

    const { row, stillQueued } = await getItemForOp(op);

    expect(stillQueued).toBe(true);
    expect(new TextDecoder().decode(row?.data ?? new Uint8Array())).toBe('the edit');
  });

  it('reports an op a later write replaced, alongside that later write’s row', async () => {
    seedQueued(LINK_PATH, 'first edit');
    const [op] = await listPendingOps(USER);
    seedQueued(LINK_PATH, 'second edit');

    const { row, stillQueued } = await getItemForOp(op);

    // The row is the newer write's — which is exactly why the caller must not
    // send it under this op.
    expect(stillQueued).toBe(false);
    expect(new TextDecoder().decode(row?.data ?? new Uint8Array())).toBe('second edit');
  });

  it('reports an op whose path was deleted since, though a row is queued there', async () => {
    seedQueued(LINK_PATH, 'created');
    const [op] = await listPendingOps(USER);
    inTx((tx) => enqueueDeleteTx(tx, USER, LINK_PATH, 0));

    // A queue row exists at the path — a delete — so "is anything queued here"
    // would say yes. The test is on the write, not on the path.
    expect((await getItemForOp(op)).stillQueued).toBe(false);
  });

  it('reports an op that is no longer queued at all', async () => {
    seedQueued(LINK_PATH, 'pushed');
    const [op] = await listPendingOps(USER);
    await clearDrainedOps([op]);

    expect((await getItemForOp(op)).stillQueued).toBe(false);
  });

  it('does not take another account’s op at the same path for this one', async () => {
    seedQueued(LINK_PATH, 'the edit');
    const [op] = await listPendingOps(USER);

    expect((await getItemForOp({ ...op, username: 'bob' })).stillQueued).toBe(false);
  });
});

describe('stampItemUpdatedAts', () => {
  it('restamps its rows and no-ops for missing ones', async () => {
    inTx((tx) => putItemsTx(tx, [toItemRecord(LINK_PATH, 1000, utf8('x'))]));

    await stampItemUpdatedAts(USER, [
      { path: LINK_PATH, updatedAt: 7777 },
      { path: 'links/gone.enc', updatedAt: 7777 },
    ]);

    expect((await getItem(LINK_PATH))?.updatedAt).toBe(7777);
    expect(await bulkGetItems(['links/gone.enc'])).toEqual([undefined]);
  });

  it('restamps a batch spanning several statements', async () => {
    const paths = Array.from(
      { length: 600 },
      (_, i) => `links/l_${String(i).padStart(3, '0')}.enc`,
    );
    inTx((tx) =>
      putItemsTx(
        tx,
        paths.map((path) => toItemRecord(path, 1000, utf8('x'))),
      ),
    );

    await stampItemUpdatedAts(
      USER,
      paths.map((path, i) => ({ path, updatedAt: 2000 + i })),
    );

    const rows = await bulkGetItems(paths);
    expect(rows.map((row) => row?.updatedAt)).toEqual(paths.map((_, i) => 2000 + i));
  });

  // An UPDATE … FROM that matches one row twice applies an arbitrary one, so the
  // store dedupes first: the last stamp wins, as the per-path updates left it.
  it('keeps the last stamp for a path repeated in the batch', async () => {
    inTx((tx) => putItemsTx(tx, [toItemRecord(LINK_PATH, 1000, utf8('x'))]));

    await stampItemUpdatedAts(USER, [
      { path: LINK_PATH, updatedAt: 3000 },
      { path: LINK_PATH, updatedAt: 2000 },
    ]);

    expect((await getItem(LINK_PATH))?.updatedAt).toBe(2000);
  });

  // Only the stamp moves: the payload and the rest of the row are the same row.
  it('leaves the rest of the row alone', async () => {
    inTx((tx) => putItemsTx(tx, [toItemRecord(LINK_PATH, 1000, utf8('body'))]));
    await markItemDataFile(LINK_PATH, true);

    await stampItemUpdatedAts(USER, [{ path: LINK_PATH, updatedAt: 2000 }]);

    const row = await getItem(LINK_PATH);
    expect(row?.data).toStrictEqual(utf8('body'));
    expect(row?.hasDataFile).toBeTruthy();
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
    await stampItemUpdatedAts(USER, [{ path: FILE_PATH, updatedAt: 2000 }]);

    expect(await markItemDataFileIfCurrent(FILE_PATH, 1000)).toBe(false);
    expect((await getItem(FILE_PATH))?.hasDataFile).toBeFalsy();
  });
});
