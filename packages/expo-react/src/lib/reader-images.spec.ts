import { READER_IMAGE_MAX_DIMENSION } from '@stxapps/shared';

import { probeImageSize } from './image';
import { collectReaderImagesPreferring } from './reader-images';

// The capture screen's image collection: the bytes the PAGE fetched and encoded, where
// they are what web-react's encoder writes, and a native fetch for every other address.
// What matters is the boundary — a page's scripts can post anything, so a picture is
// taken from it only as a JPEG whose size is measured here, never as posted.

jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => globalThis.crypto.randomUUID() }));
jest.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: {} }));
jest.mock('./image', () => ({ probeImageSize: jest.fn() }));

// Twelve bytes: the sniff reads no shorter input.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SOURCES = [
  { key: 'i0', url: 'https://cdn.example/a.jpg' },
  { key: 'i1', url: 'https://cdn.example/b.jpg' },
];

// The native fallback's fetch. It answers nothing usable here — what is asserted is
// WHICH addresses it was asked for.
const fetchMock = jest.fn(async () => ({ ok: false, status: 404 }));

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockClear();
  jest.mocked(probeImageSize).mockResolvedValue({ width: 640, height: 320 });
});

it('takes the page’s JPEG at its measured size, and fetches only the rest natively', async () => {
  const kept = await collectReaderImagesPreferring(SOURCES, new Map([['i0', JPEG]]));

  expect(kept).toEqual([{ key: 'i0', type: 'image/jpeg', width: 640, height: 320, bytes: JPEG }]);
  expect(fetchMock.mock.calls.map((call) => (call as unknown[])[0])).toEqual([SOURCES[1].url]);
});

it('refuses what the page’s encoder never writes, and fetches it natively instead', async () => {
  // Not a JPEG — an original passed through, or whatever a page's script posted.
  const notJpeg = await collectReaderImagesPreferring(SOURCES.slice(0, 1), new Map([['i0', PNG]]));
  expect(notJpeg).toEqual([]);

  // A JPEG past the pack's dimension cap — measured, not taken from the message.
  jest
    .mocked(probeImageSize)
    .mockResolvedValue({ width: READER_IMAGE_MAX_DIMENSION + 1, height: 500 });
  const tooBig = await collectReaderImagesPreferring(SOURCES.slice(0, 1), new Map([['i0', JPEG]]));
  expect(tooBig).toEqual([]);

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenCalledWith(SOURCES[0].url, expect.anything());
});
