// db.ts's statement cache: what drizzle's connection keeps compiled. On the
// device a statement nobody finalizes stays compiled for the life of the
// connection, which is the life of the process, and drizzle's expo driver
// finalizes none (db.ts, STATEMENT_CACHE_SIZE). Every query leaking one was
// ~320 MB of native heap over a 10,000-link restore sync on Android, and nothing
// fails or warns when it comes back: a spec on the SQL stays green, the iOS
// simulator has the Mac's memory, and only a sampled `dumpsys meminfo` shows it
// (docs/data-lifecycle.md, _readings — expo_). So these pin the count of live
// statements, which the node:sqlite shim keeps as the device would
// (testing/node-sqlite.ts, `statementCounts`), through the real store helpers.

import { sql } from 'drizzle-orm';

import { utf8 } from '@stxapps/shared';

import { getDb, STATEMENT_CACHE_SIZE } from './db';
import { bulkGetItems, getItemForOp, putItemsTx } from './item-store';
import { enqueuePutTx, listPendingOps } from './pending-store';
import { toItemRecord } from './projection';
import { seedNewAccount } from './sync-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({
  newId: () => globalThis.crypto.randomUUID(),
}));

const { statementCounts } = require('../testing/node-sqlite') as {
  statementCounts: () => { prepared: number; live: number };
};

const USER = 'alice';
// One past the largest `IN (…)` batch the stores send (IN_BATCH, item-store.ts),
// so the batches below come in every length bulkGetItems can produce.
const PATHS = Array.from({ length: 500 }, (_, i) => `links/l_${i}.enc`);

beforeAll(async () => {
  await seedNewAccount(USER);
  getDb().transaction((tx) => {
    putItemsTx(
      tx,
      PATHS.map((path) => toItemRecord(path, 0, utf8(path))),
    );
    for (const path of PATHS) enqueuePutTx(tx, USER, path, 0);
  });
});

describe('the statement cache', () => {
  it('prepares a repeated query once, rather than a statement per run', async () => {
    const [op] = await listPendingOps(USER);
    // The push reads every op this way (engine.ts readForUpload): a transaction
    // around two selects, four statements a run before the cache.
    await getItemForOp(op);
    const before = statementCounts().prepared;

    for (let i = 0; i < 1_000; i++) await getItemForOp(op);

    expect(statementCounts().prepared).toBe(before);
    // The reused statements still answer: the row, and the queue's verdict on it.
    const read = await getItemForOp(op);
    expect(read.stillQueued).toBe(true);
    expect(read.row?.path).toBe(op.path);
  });

  it('keeps no more than its size compiled, however many texts run', async () => {
    const start = statementCounts().prepared;
    for (let n = 1; n <= PATHS.length; n++) {
      const rows = await bulkGetItems(PATHS.slice(0, n));
      expect(rows.every((row, i) => row?.path === PATHS[i])).toBe(true);
    }

    // Each length is its own SQL text, so this ran past the cache's size —
    // without that, the bound below would hold vacuously.
    expect(statementCounts().prepared - start).toBeGreaterThan(STATEMENT_CACHE_SIZE);
    expect(statementCounts().live).toBeLessThanOrEqual(STATEMENT_CACHE_SIZE);
  });

  it('prepares an evicted text afresh rather than running a finalized one', async () => {
    // The first lengths were evicted by the case above (or are now, in
    // isolation): running them again must prepare, not throw.
    for (let n = 1; n <= PATHS.length; n++) await bulkGetItems(PATHS.slice(0, n));
    const rows = await bulkGetItems(PATHS.slice(0, 1));
    expect(rows.map((row) => row?.path)).toEqual([PATHS[0]]);
    // The raw path drizzle takes for `sql` goes through the same cache.
    const [{ count }] = getDb().all<{ count: number }>(sql`SELECT count(*) AS count FROM items`);
    expect(count).toBe(PATHS.length);
  });
});
