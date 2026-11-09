// expo's two sweeps — drift guards. The rules are shared's sync/sweeps.ts, and
// web-react's sweep specs are canonical for what each rule means. What is expo's
// own, and so only pinned here, is how this store is READ and how a delete lands:
// the key-only scans (namespacePaths / presentPaths / namespaceStamps), the paged
// entity scan with its yields, the plaintext file on disk that goes with a row, and
// the writes that can land mid-scan from outside a cycle (the Android share
// activity shares this process and database). Every case that says "keeps" has a
// positive control beside it that deletes, so a sweep that deleted nothing at all
// would fail.

import { and, eq } from 'drizzle-orm';
import { File, Paths } from 'expo-file-system';

import {
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  LINKS_PREFIX,
  MY_LIST_ID,
  newFacet,
  ORPHAN_GRACE_MS,
  ORPHAN_SWEEP_INTERVAL_MS,
  pathFromId,
} from '@stxapps/shared';

import { resetFileSystem, writeFileText } from '../testing/memory-file-system';
import { getDb, items, pendingOps, syncMeta } from './db';
import { dataFileFor } from './file-store';
import { putItemsTx } from './item-store';
import { writeExtraction, writeFile, writeLink } from './mutations';
import { listPendingOps } from './pending-store';
import { toItemRecord } from './projection';
import { sweepDanglingExtractions } from './sweep-dangling-extractions';
import { sweepOrphanFiles } from './sweep-orphan-files';
import { recordUnreadablePaths, seedNewAccount } from './sync-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => globalThis.crypto.randomUUID() }));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => globalThis.crypto.randomUUID() }));
// The scan's yield, made a seam: a case can land a write between two pages.
let mockOnYield: (() => Promise<void>) | undefined;
jest.mock('../lib/yield-to-main', () => ({
  yieldToMain: () => mockOnYield?.() ?? Promise.resolve(),
}));

const USER = 'alice';
const NOW = 1_800_000_000_000;
const OLD = NOW - ORPHAN_GRACE_MS - 1;

const filePath = (id: string) => pathFromId(id, FILES_PREFIX);
const rowExists = (path: string) =>
  getDb().select().from(items).where(eq(items.path, path)).get() !== undefined;
const blobExists = (id: string) => rowExists(filePath(id)) && dataFileFor(filePath(id)).exists;
const queuedDeletes = async () =>
  (await listPendingOps(USER)).filter((op) => op.op === 'delete').map((op) => op.path);

// As a completed sync leaves a write: pushed (no op queued), stamped by the server.
function settle(path: string, updatedAt = OLD): void {
  getDb()
    .delete(pendingOps)
    .where(and(eq(pendingOps.username, USER), eq(pendingOps.path, path)))
    .run();
  getDb().update(items).set({ updatedAt }).where(eq(items.path, path)).run();
}

async function pushedFile(id: string, updatedAt = OLD): Promise<void> {
  const source = `${Paths.cache.uri}/${id}`;
  writeFileText(source, id);
  await writeFile(USER, id, new File(source));
  settle(filePath(id), updatedAt);
}

async function pushedLink(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const path = pathFromId(id, LINKS_PREFIX);
  await writeLink(
    USER,
    {
      path,
      url: `https://example.com/${id}`,
      listId: MY_LIST_ID,
      tagIds: [],
      createdAt: 0,
      updatedAt: 0,
      ...extra,
    },
    {},
  );
  settle(path);
}

async function pushedExtraction(linkId: string, screenshotId: string): Promise<void> {
  await writeExtraction(USER, linkId, {
    fields: { screenshotId },
    facet: 'screenshot',
    state: newFacet('done', 'expo:fg'),
  });
  settle(pathFromId(linkId, EXTRACTIONS_PREFIX));
}

// As migration 1 leaves a row from the first release: no proof the record is complete.
function unproven(): void {
  getDb()
    .update(syncMeta)
    .set({ unreadableRecordCompleteAt: null })
    .where(eq(syncMeta.username, USER))
    .run();
}

beforeEach(async () => {
  resetFileSystem();
  mockOnYield = undefined;
  getDb().delete(items).run();
  getDb().delete(pendingOps).run();
  await seedNewAccount(USER);
});

describe('sweepDanglingExtractions', () => {
  it('deletes an extraction whose link is gone, with its blob on disk, and spares a linked one', async () => {
    await pushedFile('shot-gone');
    await pushedExtraction('l_gone', 'shot-gone');
    await pushedLink('l_here');
    await pushedFile('shot-here');
    await pushedExtraction('l_here', 'shot-here');

    await expect(sweepDanglingExtractions(USER)).resolves.toBe(1);

    expect(rowExists(pathFromId('l_gone', EXTRACTIONS_PREFIX))).toBe(false);
    expect(blobExists('shot-gone')).toBe(false);
    expect((await queuedDeletes()).sort()).toEqual(
      [pathFromId('l_gone', EXTRACTIONS_PREFIX), filePath('shot-gone')].sort(),
    );
    expect(rowExists(pathFromId('l_here', EXTRACTIONS_PREFIX))).toBe(true);
    expect(blobExists('shot-here')).toBe(true);
  });

  // A store migration 1 brought up: every released build skipped without recording,
  // so until a full listing completes with the record, an absent link proves nothing.
  it('does nothing until a full listing has completed with the record in place', async () => {
    await pushedFile('shot-gone');
    await pushedExtraction('l_gone', 'shot-gone');
    unproven();

    await expect(sweepDanglingExtractions(USER)).resolves.toBe(0);

    expect(blobExists('shot-gone')).toBe(true);
  });

  it('spares the extraction of a link a pull skipped as unreadable', async () => {
    await pushedFile('shot-1');
    await pushedExtraction('l_skipped', 'shot-1');
    await recordUnreadablePaths(USER, [
      { path: pathFromId('l_skipped', LINKS_PREFIX), updatedAt: 1 },
    ]);

    await expect(sweepDanglingExtractions(USER)).resolves.toBe(0);

    expect(blobExists('shot-1')).toBe(true);
  });
});

describe('sweepOrphanFiles', () => {
  it('deletes an old blob nothing names, row and file, and spares one named in a field it has never heard of', async () => {
    await pushedFile('f_orphan');
    await pushedFile('f_named');
    await pushedLink('l_1', { someNewerClientsField: { deep: ['f_named'] } });

    await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(1);

    expect(blobExists('f_orphan')).toBe(false);
    expect(await queuedDeletes()).toEqual([filePath('f_orphan')]);
    expect(blobExists('f_named')).toBe(true);
  });

  it('spares a blob younger than the grace, and one with a write queued', async () => {
    await pushedFile('f_old');
    await pushedFile('f_young', NOW - ORPHAN_GRACE_MS + 1);
    const source = `${Paths.cache.uri}/f_queued`;
    writeFileText(source, 'q');
    await writeFile(USER, 'f_queued', new File(source));

    await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(1);

    expect(blobExists('f_old')).toBe(false);
    expect(blobExists('f_young')).toBe(true);
    expect(blobExists('f_queued')).toBe(true);
  });

  it('does not run until a full listing has completed with the record in place', async () => {
    await pushedFile('f_orphan');
    unproven();

    await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(0);

    expect(blobExists('f_orphan')).toBe(true);
  });

  it('does not run while any path is recorded unreadable', async () => {
    await pushedFile('f_orphan');
    await recordUnreadablePaths(USER, [{ path: 'lists/s_1.enc', updatedAt: 1 }]);

    await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(0);

    expect(blobExists('f_orphan')).toBe(true);
  });

  it('stops at an entity row with no bytes', async () => {
    await pushedFile('f_orphan');
    getDb().transaction((tx) => putItemsTx(tx, [toItemRecord('links/l_bare.enc', OLD)]));

    await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(0);

    expect(blobExists('f_orphan')).toBe(true);
  });

  // The cycle lock holds off cycles, not writes: the Android share activity or a
  // local edit can name an old blob between two pages of the scan. The new link
  // sorts BEFORE the page already read (l_0 < l_1), so the scan never sees it, and
  // only the queue comparison can.
  it('stops when an entity write lands while it scans', async () => {
    await pushedFile('f_orphan');
    await pushedLink('l_1');
    mockOnYield = async () => {
      mockOnYield = undefined;
      await pushedLinkUnsettled('l_0', 'f_orphan');
    };

    await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(0);

    expect(blobExists('f_orphan')).toBe(true);
  });

  it('runs at most once an interval, counted from a run that finished', async () => {
    await pushedFile('f_1');
    await expect(sweepOrphanFiles(USER, NOW)).resolves.toBe(1);
    await pushedFile('f_2');

    await expect(sweepOrphanFiles(USER, NOW + ORPHAN_SWEEP_INTERVAL_MS - 1)).resolves.toBe(0);
    await expect(sweepOrphanFiles(USER, NOW + ORPHAN_SWEEP_INTERVAL_MS)).resolves.toBe(1);
  });
});

// A link written and not yet pushed: its op is still queued.
async function pushedLinkUnsettled(id: string, fileRef: string): Promise<void> {
  await writeLink(
    USER,
    {
      path: pathFromId(id, LINKS_PREFIX),
      url: `https://example.com/${id}`,
      listId: MY_LIST_ID,
      tagIds: [],
      createdAt: 0,
      updatedAt: 0,
      customImageId: fileRef,
    },
    {},
  );
}
