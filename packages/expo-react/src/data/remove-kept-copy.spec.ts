import { File, Paths } from 'expo-file-system';

import { EXTRACTIONS_PREFIX, FILES_PREFIX, newFacet, pathFromId } from '@stxapps/shared';

import { resetFileSystem, writeFileText } from '../testing/memory-file-system';
import { getDb, items } from './db';
import { removeKeptCopy, writeExtraction, writeFile } from './mutations';
import { readExtraction } from './queries';
import { seedNewAccount } from './sync-store';

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

it('writes nothing when there is no such copy — and never creates an extraction', async () => {
  await expect(removeKeptCopy(USER, LINK_ID, 'screenshot')).resolves.toBe(false);
  expect(rowExists(pathFromId(LINK_ID, EXTRACTIONS_PREFIX))).toBe(false);
});
