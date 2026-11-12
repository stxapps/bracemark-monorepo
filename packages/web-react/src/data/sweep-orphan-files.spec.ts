import {
  FILES_PREFIX,
  LINKS_PREFIX,
  MY_LIST_ID,
  ORPHAN_GRACE_MS,
  ORPHAN_SWEEP_BACKLOG_INTERVAL_MS,
  ORPHAN_SWEEP_INTERVAL_MS,
  ORPHAN_SWEEP_MAX,
  pathFromId,
} from '@stxapps/shared';

import { db } from './db';
import { writeExtraction, writeFile, writeLink } from './mutations';
import { toItemRecord } from './projection';
import { sweepOrphanFiles } from './sweep-orphan-files';
import { getSyncMeta, recordUnreadablePaths, seedNewAccount } from './sync-store';

// A skip as the pull records it: the path and the stamp it was listed at.
const stamped = (path: string) => ({ path, updatedAt: 1 });

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
  // A synced account: the cursor is the server clock the grace is measured against.
  await db.syncMeta.update(USER, { syncCursorUpdatedAt: NOW });
});

it('measures the grace on the server’s clock, not a device clock that runs ahead', async () => {
  // Another device uploaded this blob a day ago and has not named it yet. This device's
  // clock is 40 days fast, so by its own clock the blob is 41 days old.
  await pushedFile('fresh', NOW - 24 * 60 * 60 * 1000);
  const FAST = NOW + 40 * 24 * 60 * 60 * 1000;

  await expect(sweepOrphanFiles(USER, FAST)).resolves.toBe(0);
  expect(await exists('fresh')).toBe(true);
});

it('allows the grace exactly a day past the newest server stamp, no more', async () => {
  // With a clock far ahead, "now" is the cursor plus ONE day: a blob 29 days and an hour
  // older than the cursor is past the 30-day grace by that measure, one an hour younger is not.
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  await pushedFile('past', NOW - 29 * DAY - HOUR);
  await pushedFile('inside', NOW - 29 * DAY + HOUR);

  await expect(sweepOrphanFiles(USER, NOW + 100 * DAY)).resolves.toBe(1);

  expect(await exists('past')).toBe(false);
  expect(await exists('inside')).toBe(true);
});

it('spares everything when no server stamp has been pulled', async () => {
  await pushedFile('orphan');
  await db.syncMeta.update(USER, { syncCursorUpdatedAt: 0 });

  await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(0);
  expect(await exists('orphan')).toBe(true);
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

// The same rule one step further: a newer client may keep a MAP keyed by blob id,
// and then the id is never a value anywhere. A key is a string in the entity like
// any other, and striking it can only spare a blob.
it('counts a blob id used as an object key, not only as a value', async () => {
  await pushedFile('keyed');
  await pushedFile('orphan');
  await link('l1', { someNewerClientsMap: { keyed: { width: 1 } } });

  await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(1);

  expect(await exists('keyed')).toBe(true);
  expect(await exists('orphan')).toBe(false);
});

it('spares a blob younger than the grace, and one with a write still queued', async () => {
  await pushedFile('young', NOW - 1000);
  await writeFile(USER, 'unpushed', BYTES); // updatedAt 0, a pending put

  await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(0);
  expect(await exists('young')).toBe(true);
  expect(await exists('unpushed')).toBe(true);
});

// A row from before the record can't vouch for this store (the dangling sweep's spec
// has the reasoning); the first case above is the positive control.
it('does nothing until a full listing has completed with the record in place', async () => {
  await pushedFile('orphan');
  await db.syncMeta.update(USER, { unreadableRecordCompleteAt: undefined });

  await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(0);
  expect(await exists('orphan')).toBe(true);
});

it('does nothing while any path is recorded unreadable', async () => {
  await pushedFile('orphan');
  await recordUnreadablePaths(USER, ['links/skipped.enc'].map(stamped));

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

// A backlog. At the weekly interval it drained at ORPHAN_SWEEP_MAX a week, and an
// account full of blobs older builds leaked sat at its byte ceiling for months,
// with nothing the user could delete to make room. A run the cap cut short comes
// back in a day; the run that empties the backlog puts the week back.
//
// The long timeout is the fake's, not the sweep's: each of the 500 deletes is its
// own transaction, and fake-indexeddb takes a couple of seconds over them alone
// and past jest's five beside the other suites (sync/engine.spec.ts, _the put
// chunk_, has the same reason).
const SLOW_MS = 30_000;
it(
  'comes back in a day, not a week, after a run its cap cut short',
  async () => {
    const ids = Array.from({ length: ORPHAN_SWEEP_MAX + 1 }, (_, i) => `backlog-${i}`);
    await db.items.bulkPut(ids.map((id) => toItemRecord(filePath(id), OLD)));

    await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(ORPHAN_SWEEP_MAX);

    const day = ORPHAN_SWEEP_BACKLOG_INTERVAL_MS;
    await expect(sweepOrphanFiles(USER, NOW + day - 1)).resolves.toBe(0);
    await expect(sweepOrphanFiles(USER, NOW + day)).resolves.toBe(1);

    await pushedFile('later');
    await expect(sweepOrphanFiles(USER, NOW + 2 * day)).resolves.toBe(0);
    expect(await exists('later')).toBe(true);
  },
  SLOW_MS,
);
