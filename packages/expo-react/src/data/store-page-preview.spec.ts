import { File, Paths } from 'expo-file-system';

import { EXTRACTIONS_PREFIX, newFacet, pathFromId, UnreadablePathError } from '@stxapps/shared';

import { resetFileSystem } from '../testing/memory-file-system';
import { getDb, items } from './db';
import { writeExtraction } from './mutations';
import { readExtraction } from './queries';
import { storePagePreview } from './store-page-preview';
import { recordUnreadablePaths, seedNewAccount } from './sync-store';

// _Update preview_'s write (the capture screen): a title and image read from the live
// page. Two rules, both silent if lost — the list would just keep showing what it did:
//   - it is a TAP, so it writes whatever tier held the facet before;
//   - it writes only what it HAD, so a page whose image couldn't be fetched keeps the
//     preview the link already had.

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
let mockIds = 0;
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => `img-${++mockIds}` }));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => globalThis.crypto.randomUUID() }));

const USER = 'alice';

function imageFile(): File {
  const file = new File(Paths.cache, `preview-${mockIds}.jpg`);
  file.write(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]));
  return file;
}

beforeEach(async () => {
  mockIds = 0;
  resetFileSystem();
  getDb().delete(items).run();
  await seedNewAccount(USER);
  // A preview the link already has, from the server tier, settled.
  await writeExtraction(USER, 'l1', {
    fields: { title: 'Old title', imageId: 'old-image' },
    facet: 'titleImage',
    state: newFacet('done', 'server'),
  });
});

it('replaces the title and image, at the live-page tier, whatever held them', async () => {
  await expect(
    storePagePreview(USER, 'l1', { title: 'New title', image: imageFile() }),
  ).resolves.toBe(true);

  const extraction = await readExtraction('l1');
  expect(extraction).toMatchObject({
    title: 'New title',
    imageId: expect.stringMatching(/^img-/),
    facets: { titleImage: { status: 'done', extractedBy: 'expo:fg' } },
  });
  expect(extraction?.imageId).not.toBe('old-image');
});

it('keeps the image it already had when the page yielded only a title', async () => {
  await storePagePreview(USER, 'l1', { title: 'New title' });

  expect(await readExtraction('l1')).toMatchObject({ title: 'New title', imageId: 'old-image' });
});

it('writes nothing when the page yielded nothing', async () => {
  await expect(storePagePreview(USER, 'l1', {})).resolves.toBe(false);

  expect(await readExtraction('l1')).toMatchObject({
    title: 'Old title',
    imageId: 'old-image',
    facets: { titleImage: { extractedBy: 'server' } },
  });
});

it('writes no blob for a link whose extraction this device could not open', async () => {
  // The link's extraction is the one beforeEach wrote; here it is also one the pull could
  // not open, so the image would be uploaded with no extraction naming it.
  await recordUnreadablePaths(USER, [{ path: pathFromId('l1', EXTRACTIONS_PREFIX), updatedAt: 1 }]);
  const before = getDb().select().from(items).all().length;

  await expect(storePagePreview(USER, 'l1', { title: 'New', image: imageFile() })).rejects.toThrow(
    UnreadablePathError,
  );

  expect(getDb().select().from(items).all()).toHaveLength(before);
  expect((await readExtraction('l1'))?.title).toBe('Old title');
});
