import { gunzipSync } from 'fflate';

import { FILES_PREFIX, pathFromId } from '@stxapps/shared';

import { readFileBytes, resetFileSystem } from '../testing/memory-file-system';
import { getDb, items } from './db';
import { dataFileFor } from './file-store';
import { readExtraction } from './queries';
import { storeReadModeCopy } from './store-read-mode';
import { seedNewAccount } from './sync-store';

// Storing a read-mode copy taken from a live page (a Safari share, the capture
// screen's WebView). The copy crossed a process or context boundary, so it is
// validated here; once valid it is
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
  await expect(storeReadModeCopy(USER, 'l1', DOC)).resolves.toBe(true);

  const extraction = await readExtraction('l1');
  expect(extraction?.readModeId).toBe('copy-1');
  expect(extraction?.facets.readMode).toMatchObject({ status: 'done', extractedBy: 'expo:fg' });

  const bytes = readFileBytes(dataFileFor(pathFromId('copy-1', FILES_PREFIX)).uri);
  expect(JSON.parse(new TextDecoder().decode(gunzipSync(bytes)))).toEqual(DOC);
});

// A Safari share's draft carries the copy as JSON text: the iOS share extension
// passes it along unparsed, and this is where it first becomes objects.
it('stores a copy handed over as JSON text, the same as the doc itself', async () => {
  await expect(storeReadModeCopy(USER, 'l1', JSON.stringify(DOC))).resolves.toBe(true);

  expect((await readExtraction('l1'))?.readModeId).toBe('copy-1');
  const bytes = readFileBytes(dataFileFor(pathFromId('copy-1', FILES_PREFIX)).uri);
  expect(JSON.parse(new TextDecoder().decode(gunzipSync(bytes)))).toEqual(DOC);
});

it('stores nothing for a copy that is not a ReaderDoc', async () => {
  await expect(storeReadModeCopy(USER, 'l1', { html: '<p>x</p>' })).resolves.toBe(false);
  expect(await readExtraction('l1')).toBeUndefined();
});

it('stores nothing for text that is not JSON, or is JSON of something else', async () => {
  await expect(storeReadModeCopy(USER, 'l1', '{"version":1,"blocks":[')).resolves.toBe(false);
  await expect(storeReadModeCopy(USER, 'l1', '"a string"')).resolves.toBe(false);
  expect(await readExtraction('l1')).toBeUndefined();
});
