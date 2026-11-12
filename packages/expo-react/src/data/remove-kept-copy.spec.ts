import { File, Paths } from 'expo-file-system';

import {
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  LINKS_PREFIX,
  newFacet,
  pathFromId,
  UnreadablePathError,
} from '@stxapps/shared';

import { resetFileSystem, writeFileText } from '../testing/memory-file-system';
import { getDb, items } from './db';
import {
  assertExtractionWritable,
  bulkDeleteEntities,
  bulkWriteEntities,
  bulkWriteLinks,
  removeKeptCopy,
  writeExtraction,
  writeFile,
  writeLink,
} from './mutations';
import { readExtraction } from './queries';
import { recordUnreadablePaths, seedNewAccount } from './sync-store';

// expo's removeKeptCopy — the port of web-react's (data/mutations.spec.ts there has
// the reasoning). The two properties pinned on both platforms: a removed copy is GONE
// (row and file) and MARKED rather than forgotten, and removing a copy that isn't
// there writes nothing at all.

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => globalThis.crypto.randomUUID() }));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => globalThis.crypto.randomUUID() }));

const USER = 'alice';
const LINK_ID = 'l1';

async function file(id: string): Promise<void> {
  const source = `${Paths.cache.uri}/${id}`;
  writeFileText(source, id);
  await writeFile(USER, id, new File(source));
}

const rowExists = (path: string) =>
  getDb()
    .select()
    .from(items)
    .all()
    .some((row) => row.path === path);

beforeEach(async () => {
  resetFileSystem();
  getDb().delete(items).run();
  await seedNewAccount(USER);
});

it('drops the ref, deletes the blob, and marks the facet removed — still done', async () => {
  await file('read-1');
  await file('shot-1');
  await writeExtraction(USER, LINK_ID, {
    fields: { readModeId: 'read-1', screenshotId: 'shot-1' },
    facet: 'readMode',
    state: newFacet('done', 'expo:fg'),
  });

  await expect(removeKeptCopy(USER, LINK_ID, 'readMode')).resolves.toBe(true);

  const extraction = await readExtraction(LINK_ID);
  expect(extraction?.readModeId).toBeUndefined();
  expect(extraction?.facets.readMode).toMatchObject({
    status: 'done',
    removedAt: expect.any(Number),
  });
  expect(rowExists(pathFromId('read-1', FILES_PREFIX))).toBe(false);
  expect(extraction?.screenshotId).toBe('shot-1');
  expect(rowExists(pathFromId('shot-1', FILES_PREFIX))).toBe(true);
});

it('removes a read-mode copy’s image pack with its text', async () => {
  await file('read-1');
  await file('pack-1');
  await writeExtraction(USER, LINK_ID, {
    fields: { readModeId: 'read-1', readModeImagesId: 'pack-1' },
    facet: 'readMode',
    state: newFacet('done', 'expo:fg'),
  });

  await expect(removeKeptCopy(USER, LINK_ID, 'readMode')).resolves.toBe(true);

  const extraction = await readExtraction(LINK_ID);
  expect(extraction?.readModeId).toBeUndefined();
  expect(extraction?.readModeImagesId).toBeUndefined();
  expect(rowExists(pathFromId('read-1', FILES_PREFIX))).toBe(false);
  expect(rowExists(pathFromId('pack-1', FILES_PREFIX))).toBe(false);
});

it('writes nothing when there is no such copy — and never creates an extraction', async () => {
  await expect(removeKeptCopy(USER, LINK_ID, 'screenshot')).resolves.toBe(false);
  expect(rowExists(pathFromId(LINK_ID, EXTRACTIONS_PREFIX))).toBe(false);
});

it('writeExtraction refuses a link whose extraction the device could not open', async () => {
  // "No extraction here" is not "never extracted" while the path is recorded: a write built
  // on this view would overwrite the server's copy and the kept copies it names.
  const path = pathFromId(LINK_ID, EXTRACTIONS_PREFIX);
  await recordUnreadablePaths(USER, [{ path, updatedAt: 1000 }]);

  await expect(writeExtraction(USER, LINK_ID, { fields: { title: 'x' } })).rejects.toThrow(
    UnreadablePathError,
  );
  expect(rowExists(path)).toBe(false);

  // Another link is unaffected.
  await writeExtraction(USER, 'l_other', { fields: { title: 'fine' } });
  expect(rowExists(pathFromId('l_other', EXTRACTIONS_PREFIX))).toBe(true);
});

// THE WRITE EDGE AND THE UNREADABLE RECORD (web's mutations.spec has the reasoning): a put to
// a recorded path is refused in the write's own transaction, whoever the writer is.
describe('the write edge and the unreadable record', () => {
  const EXTRACTION = pathFromId(LINK_ID, EXTRACTIONS_PREFIX);
  const LINK = pathFromId('l_rec', LINKS_PREFIX);
  const record = (path: string) => recordUnreadablePaths(USER, [{ path, updatedAt: 1000 }]);
  const linkItem = {
    path: LINK,
    url: 'https://example.com/a',
    listId: 'my-list',
    tagIds: [],
    createdAt: 1,
    updatedAt: 1,
  };

  it('refuses a link write to a recorded path', async () => {
    await writeLink(USER, linkItem, {});
    await record(LINK);

    await expect(writeLink(USER, linkItem, { listId: 'archive' })).rejects.toThrow(
      UnreadablePathError,
    );
    await expect(bulkWriteLinks(USER, [{ link: linkItem, patch: {} }])).rejects.toThrow(
      UnreadablePathError,
    );
  });

  it('refuses removing a kept copy from a recorded extraction', async () => {
    await file('shot-1');
    await writeExtraction(USER, LINK_ID, {
      fields: { screenshotId: 'shot-1' },
      facet: 'screenshot',
      state: newFacet('done', 'server'),
    });
    await record(EXTRACTION);

    await expect(removeKeptCopy(USER, LINK_ID, 'screenshot')).rejects.toThrow(UnreadablePathError);

    expect((await readExtraction(LINK_ID))?.screenshotId).toBe('shot-1');
  });

  it('lets a bulk restore skip a recorded path, and refuses one that may not skip', async () => {
    const other = pathFromId('l_other', LINKS_PREFIX);
    await record(LINK);

    const written = await bulkWriteEntities(
      USER,
      [
        { path: LINK, data: { url: 'https://example.com/a' } },
        { path: other, data: { url: 'https://example.com/b' } },
      ],
      { skipExisting: true },
    );

    expect(written).toEqual([other]);
    expect(rowExists(LINK)).toBe(false);
    await expect(
      bulkWriteEntities(USER, [{ path: LINK, data: { url: 'https://example.com/a' } }]),
    ).rejects.toThrow(UnreadablePathError);
  });

  it('does not refuse a delete of a recorded path', async () => {
    await writeLink(USER, linkItem, {});
    await record(LINK);

    await bulkDeleteEntities(USER, [LINK]);

    expect(rowExists(LINK)).toBe(false);
  });

  it('answers the question before any work is done', async () => {
    await expect(assertExtractionWritable(USER, LINK_ID)).resolves.toBeUndefined();
    await record(EXTRACTION);

    await expect(assertExtractionWritable(USER, LINK_ID)).rejects.toThrow(UnreadablePathError);
    await expect(assertExtractionWritable(USER, 'l_b')).resolves.toBeUndefined();
  });
});
