import { gunzipSync } from 'fflate';

import { decodeReaderImages, FILES_PREFIX, pathFromId } from '@stxapps/shared';

import { collectReaderImages, collectReaderImagesPreferring } from '../lib/reader-images';
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
// The text copy's id is minted first, then the pack's: `copy-1`, `copy-2`.
let mockIds = 0;
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => `copy-${++mockIds}` }));
// The native fetch and decode are a seam; the settling and the two writes are real.
jest.mock('../lib/reader-images', () => ({
  collectReaderImages: jest.fn(async () => []),
  collectReaderImagesPreferring: jest.fn(async () => []),
}));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => globalThis.crypto.randomUUID() }));

const USER = 'alice';
const DOC = {
  version: 1,
  capturedAt: 1,
  blocks: [{ id: 'b0', kind: 'paragraph', runs: [{ text: 'Kept from Safari.' }] }],
};

beforeEach(async () => {
  mockIds = 0;
  jest.mocked(collectReaderImages).mockClear();
  jest.mocked(collectReaderImagesPreferring).mockClear();
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

describe('a capture that carries image addresses', () => {
  const CAPTURE = {
    doc: {
      version: 1,
      capturedAt: 1,
      blocks: [
        { id: 'b0', kind: 'paragraph', runs: [{ text: 'Kept from Safari.' }] },
        { id: 'b1', kind: 'figure', text: 'A chart', image: 'i0' },
        { id: 'b2', kind: 'figure', text: 'A photo', image: 'i1' },
      ],
    },
    images: [
      { key: 'i0', url: 'https://cdn.example/chart.png' },
      { key: 'i1', url: 'https://cdn.example/photo.jpg' },
      // Not an address a fetch may be handed; dropped at this boundary.
      { key: 'i2', url: ['javascript', 'steal()'].join(':') },
    ],
  };
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]);
  const storedDoc = () =>
    JSON.parse(
      new TextDecoder().decode(
        gunzipSync(readFileBytes(dataFileFor(pathFromId('copy-1', FILES_PREFIX)).uri)),
      ),
    ) as { blocks: unknown[] };

  it('keeps what it could fetch in one pack, and settles the document against it', async () => {
    jest
      .mocked(collectReaderImages)
      .mockResolvedValue([{ key: 'i0', type: 'image/jpeg', width: 640, height: 320, bytes: JPEG }]);

    await expect(
      storeReadModeCopy(USER, 'l1', JSON.stringify(CAPTURE), { images: true }),
    ).resolves.toBe(true);

    expect(collectReaderImages).toHaveBeenCalledWith(CAPTURE.images.slice(0, 2));
    const extraction = await readExtraction('l1');
    expect(extraction).toMatchObject({ readModeId: 'copy-1', readModeImagesId: 'copy-2' });
    expect(
      decodeReaderImages(readFileBytes(dataFileFor(pathFromId('copy-2', FILES_PREFIX)).uri)),
    ).toEqual([{ key: 'i0', type: 'image/jpeg', width: 640, height: 320, bytes: JPEG }]);
    expect(storedDoc().blocks).toEqual([
      CAPTURE.doc.blocks[0],
      { id: 'b1', kind: 'figure', text: 'A chart', image: 'i0', width: 640, height: 320 },
      { id: 'b2', kind: 'figure', text: 'A photo' },
    ]);
    // The addresses were for the fetch; nothing stored names one.
    expect(JSON.stringify(storedDoc())).not.toContain('cdn.example');
    expect(JSON.stringify(extraction)).not.toContain('cdn.example');
  });

  it('fetches nothing unless the caller says images are kept — and names none', async () => {
    await expect(storeReadModeCopy(USER, 'l1', CAPTURE)).resolves.toBe(true);

    expect(collectReaderImages).not.toHaveBeenCalled();
    expect((await readExtraction('l1'))?.readModeImagesId).toBeUndefined();
    expect(JSON.stringify(storedDoc())).not.toMatch(/"image"/);
  });

  it('keeps the words when fetching the images throws', async () => {
    jest.mocked(collectReaderImages).mockRejectedValue(new Error('offline'));

    await expect(storeReadModeCopy(USER, 'l1', CAPTURE, { images: true })).resolves.toBe(true);

    expect(await readExtraction('l1')).toMatchObject({ readModeId: 'copy-1' });
    expect((await readExtraction('l1'))?.readModeImagesId).toBeUndefined();
  });

  // The capture screen's path: its WebView can fetch an image with the site's session,
  // so the page is asked first and the native fetch covers the rest
  // (lib/reader-images.ts, collectReaderImagesPreferring).
  describe('with an in-page fetch (the capture screen)', () => {
    const fromPage = new Map([['i0', JPEG]]);

    it('asks the page for the addresses, then merges with the native fetch', async () => {
      const fetchFromPage = jest.fn(async () => fromPage);

      await expect(
        storeReadModeCopy(USER, 'l1', CAPTURE, { images: true, fetchFromPage }),
      ).resolves.toBe(true);

      expect(fetchFromPage).toHaveBeenCalledWith(CAPTURE.images.slice(0, 2));
      expect(collectReaderImagesPreferring).toHaveBeenCalledWith(
        CAPTURE.images.slice(0, 2),
        fromPage,
      );
      expect(collectReaderImages).not.toHaveBeenCalled();
    });

    // The account's switch decides whether a copy keeps images at all — the page is no
    // exception, or turning it off would still send a request per picture to the site.
    it('asks the page for nothing when images are not kept', async () => {
      const fetchFromPage = jest.fn(async () => fromPage);

      await expect(storeReadModeCopy(USER, 'l1', CAPTURE, { fetchFromPage })).resolves.toBe(true);

      expect(fetchFromPage).not.toHaveBeenCalled();
      expect(collectReaderImagesPreferring).not.toHaveBeenCalled();
    });

    it('falls back to the native fetch when the page could not answer', async () => {
      const fetchFromPage = jest.fn(async () => {
        throw new Error('the WebView is gone');
      });

      await expect(
        storeReadModeCopy(USER, 'l1', CAPTURE, { images: true, fetchFromPage }),
      ).resolves.toBe(true);

      expect(collectReaderImages).toHaveBeenCalledWith(CAPTURE.images.slice(0, 2));
    });
  });
});
