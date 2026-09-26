// bulkWriteEntities, set-at-a-time: one stamp read, one batched put and one
// batched enqueue per call, where it used to issue a select, a put and an
// enqueue per entity (docs/data-lifecycle.md, _readings — expo_). What must not
// move with it is the contract the per-entity loop kept: each path's pending op
// carries the server stamp its row held BEFORE the write, rows are full-replace,
// junction rows follow their row, and a path repeated within one call ends as
// the last of its entries. Real in-memory SQLite over the real DDL and the real
// drizzle driver, as in item-store.spec.ts — the batching IS the SQL, so a
// stubbed store would prove nothing.

import { sql } from 'drizzle-orm';

import { LINKS_PREFIX, linkSchema, pathFromId, utf8 } from '@stxapps/shared';

import { getDb, items, itemTagIds, rowsPerStatement } from './db';
import { getItem, putItemsTx } from './item-store';
import { bulkWriteEntities } from './mutations';
import { listPendingOps } from './pending-store';
import { parseBlob, toItemRecord } from './projection';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
// file-store imports the expo-crypto barrel, whose native quick-crypto can't
// load here; nothing below encrypts. Ids stay unique per call (export-import.spec.ts).
jest.mock('@stxapps/expo-crypto', () => ({
  newId: () => globalThis.crypto.randomUUID(),
}));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({
  newId: () => globalThis.crypto.randomUUID(),
}));

const USER = 'alice';

const link = (n: number, tagIds: string[] = []) => ({
  url: `https://example.com/${n}`,
  listId: 'my-list',
  tagIds,
  createdAt: 1000 + n,
  updatedAt: 1000 + n,
});
const linkPath = (n: number) => pathFromId(`l_${String(n).padStart(4, '0')}`, LINKS_PREFIX);

beforeEach(() => {
  const tables = getDb().all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const { name } of tables) getDb().run(sql.raw(`DELETE FROM "${name}"`));
});

it('writes more entities than one statement holds, each row and op intact', async () => {
  // Past several multi-row statements for both tables, and not a multiple of either.
  const count = rowsPerStatement(items) * 5 + 7;
  const entries = Array.from({ length: count }, (_, n) => ({ path: linkPath(n), data: link(n) }));

  await bulkWriteEntities(USER, entries);

  const rows = getDb().select().from(items).all();
  expect(rows).toHaveLength(count);
  const last = await getItem(linkPath(count - 1));
  expect(last?.itemUrl).toBe(`https://example.com/${count - 1}`);
  expect(last?.itemCreatedAt).toBe(1000 + count - 1);
  const ops = await listPendingOps(USER);
  expect(ops).toHaveLength(count);
  expect(new Set(ops.map((op) => op.writeId)).size).toBe(count);
  expect(ops.every((op) => op.op === 'put' && op.baseUpdatedAt === 0)).toBe(true);
});

it('queues each path against the server stamp its row held before the write', async () => {
  // Two paths already stored at distinct server stamps, one brand new.
  getDb().transaction((tx) =>
    putItemsTx(tx, [
      toItemRecord(linkPath(1), 5000, utf8(JSON.stringify(link(1)))),
      toItemRecord(linkPath(2), 7000, utf8(JSON.stringify(link(2)))),
    ]),
  );

  await bulkWriteEntities(USER, [
    { path: linkPath(1), data: { ...link(1), url: 'https://example.com/changed' } },
    { path: linkPath(2), data: link(2) },
    { path: linkPath(3), data: link(3) },
  ]);

  const bases = Object.fromEntries(
    (await listPendingOps(USER)).map((op) => [op.path, op.baseUpdatedAt]),
  );
  expect(bases).toEqual({ [linkPath(1)]: 5000, [linkPath(2)]: 7000, [linkPath(3)]: 0 });
  // The stored row keeps its server stamp (the engine restamps on commit) and
  // takes the new bytes whole.
  const changed = await getItem(linkPath(1));
  expect(changed?.updatedAt).toBe(5000);
  expect(changed?.itemUrl).toBe('https://example.com/changed');
});

it('replaces a row whole, junction rows included', async () => {
  await bulkWriteEntities(USER, [{ path: linkPath(1), data: link(1, ['t_a', 't_b']) }]);
  await bulkWriteEntities(USER, [{ path: linkPath(1), data: link(1, ['t_c']) }]);

  const tags = getDb().select().from(itemTagIds).all();
  expect(tags).toEqual([{ path: linkPath(1), tagId: 't_c' }]);
});

it('ends a path repeated within one call as its last entry, as one write at a time would', async () => {
  await bulkWriteEntities(USER, [
    { path: linkPath(1), data: link(1, ['t_a']) },
    { path: linkPath(2), data: link(2) },
    { path: linkPath(1), data: { ...link(1, ['t_a']), url: 'https://example.com/second' } },
  ]);

  const stored = await getItem(linkPath(1));
  expect(parseBlob(stored?.data ?? undefined, linkSchema)?.url).toBe('https://example.com/second');
  expect(getDb().select().from(itemTagIds).all()).toEqual([{ path: linkPath(1), tagId: 't_a' }]);
  expect(await listPendingOps(USER)).toHaveLength(2);
});
