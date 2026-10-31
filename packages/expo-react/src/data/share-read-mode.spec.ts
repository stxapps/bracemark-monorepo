import { gunzipSync } from 'fflate';

import { FILES_PREFIX, pathFromId } from '@stxapps/shared';

import { readFileBytes, resetFileSystem } from '../testing/memory-file-system';
import { getDb, items } from './db';
import { dataFileFor } from './file-store';
import { readExtraction } from './queries';
import { applyShareReadMode } from './share-read-mode';
import { seedNewAccount } from './sync-store';

// Storing the read-mode copy a Safari share carried. The copy is the share
// extension's output read back off disk, so it is validated here; once valid it is
// written as the browser extension's are — gzipped, at the active-page tier.

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => 'copy-1' }));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => globalThis.crypto.randomUUID() }));

const USER = 'alice';
const DOC = {
  version: 1,
  capturedAt: 1,
  blocks: [{ id: 'b0', kind: 'paragraph', runs: [{ text: 'Kept from Safari.' }] }],
};

beforeEach(async () => {
  resetFileSystem();
  getDb().delete(items).run();
  await seedNewAccount(USER);
});

it('stores the copy gzipped and records it at the active-page tier', async () => {
  await expect(applyShareReadMode(USER, 'l1', DOC)).resolves.toBe(true);

  const extraction = await readExtraction('l1');
  expect(extraction?.readModeId).toBe('copy-1');
  expect(extraction?.facets.readMode).toMatchObject({ status: 'done', extractedBy: 'expo:fg' });

  const bytes = readFileBytes(dataFileFor(pathFromId('copy-1', FILES_PREFIX)).uri);
  expect(JSON.parse(new TextDecoder().decode(gunzipSync(bytes)))).toEqual(DOC);
});

it('stores nothing for a copy that is not a ReaderDoc', async () => {
  await expect(applyShareReadMode(USER, 'l1', { html: '<p>x</p>' })).resolves.toBe(false);
  expect(await readExtraction('l1')).toBeUndefined();
});
