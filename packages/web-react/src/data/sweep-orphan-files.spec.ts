import { FILES_PREFIX, LINKS_PREFIX, MY_LIST_ID, pathFromId } from '@stxapps/shared';

import { db } from './db';
import { writeExtraction, writeFile, writeLink } from './mutations';
import { ORPHAN_GRACE_MS, ORPHAN_SWEEP_INTERVAL_MS, sweepOrphanFiles } from './sweep-orphan-files';
import { getSyncMeta, recordUnreadablePaths, seedNewAccount } from './sync-store';

// The orphaned-file sweep deletes user data on every device when it is wrong, so most
// of this file is the cases where it must NOT delete (its header has the reasoning):
// a blob any entity names in any field — including one this build has never heard of;
// a blob too young, or with a write still queued; and any store it can't fully read.

const USER = 'alice';
const NOW = 1_800_000_000_000;
const OLD = NOW - ORPHAN_GRACE_MS - 1;
const BYTES = new Uint8Array([1, 2, 3]);

const filePath = (id: string) => pathFromId(id, FILES_PREFIX);
const exists = async (id: string) => (await db.items.get(filePath(id))) !== undefined;

// A blob as a completed sync leaves it: pushed (no pending op), stamped by the server.
async function pushedFile(id: string, updatedAt = OLD): Promise<void> {
  await writeFile(USER, id, BYTES);
  await db.pendingOps
    .where('[username+path]')
    .equals([USER, filePath(id)])
    .delete();
  await db.items.update(filePath(id), { updatedAt });
}

async function link(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  await writeLink(
    USER,
    {
      path: pathFromId(id, LINKS_PREFIX),
      url: `https://example.com/${id}`,
      listId: MY_LIST_ID,
      tagIds: [],
      createdAt: 0,
      updatedAt: 0,
      ...extra,
    },
    {},
  );
}

beforeEach(async () => {
  await Promise.all([db.items.clear(), db.pendingOps.clear(), db.syncMeta.clear()]);
  await seedNewAccount(USER);
});

it('sweeps an old blob nothing names, and spares the ones that are named', async () => {
  await pushedFile('orphan');
  await pushedFile('custom');
  await pushedFile('read');
  await link('l1', { customImageId: 'custom' });
  await writeExtraction(USER, 'l1', { fields: { readModeId: 'read' } });

  await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(1);

  expect(await exists('orphan')).toBe(false);
  expect(await db.pendingOps.get([USER, filePath('orphan')])).toMatchObject({ op: 'delete' });
  expect(await exists('custom')).toBe(true);
  expect(await exists('read')).toBe(true);
});

it('counts a reference in a field this build does not know — a newer client’s', async () => {
  // A newer client's extraction naming a blob under a field EXTRACTION_FILE_REF_FIELDS
  // doesn't list. Deleting it would take that client's data on every device.
  await pushedFile('future');
  await writeExtraction(USER, 'l1', {
    fields: { title: 'x' },
    facet: 'titleImage',
    state: { status: 'done', attempts: 0, thumbnails: [{ id: 'future' }] } as never,
  });

  await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(0);
  expect(await exists('future')).toBe(true);
});

it('spares a blob younger than the grace, and one with a write still queued', async () => {
  await pushedFile('young', NOW - 1000);
  await writeFile(USER, 'unpushed', BYTES); // updatedAt 0, a pending put

  await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(0);
  expect(await exists('young')).toBe(true);
  expect(await exists('unpushed')).toBe(true);
});

it('does nothing while any path is recorded unreadable', async () => {
  await pushedFile('orphan');
  await recordUnreadablePaths(USER, ['links/skipped.enc']);

  await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(0);
  expect(await exists('orphan')).toBe(true);
});

it('does nothing when an entity can’t be read', async () => {
  await pushedFile('orphan');
  await link('l1');
  await db.items.update(pathFromId('l1', LINKS_PREFIX), { data: new Uint8Array([0xff, 0x00]) });

  await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(0);
  expect(await exists('orphan')).toBe(true);
  // …and is not throttled for a week by the attempt.
  expect((await getSyncMeta(USER))?.lastOrphanSweepAt).toBeUndefined();
});

it('runs at most once a week', async () => {
  await pushedFile('a');
  await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(1);

  await pushedFile('b');
  await expect(sweepOrphanFiles(USER, NOW + 1000)).resolves.toBe(0);
  expect(await exists('b')).toBe(true);

  await expect(sweepOrphanFiles(USER, NOW + ORPHAN_SWEEP_INTERVAL_MS)).resolves.toBe(1);
  expect(await exists('b')).toBe(false);
});
