import { fetch as expoFetch } from 'expo/fetch';

import { READER_IMAGE_MAX_DIMENSION, READER_IMAGE_MAX_SOURCE_BYTES } from '@stxapps/shared';

import { probeImageSize } from './image';
import { collectReaderImagesPreferring, readBodyWithin } from './reader-images';

// The capture screen's image collection: the bytes the PAGE fetched and encoded, where
// they are what web-react's encoder writes, and a native fetch for every other address.
// What matters is the boundary — a page's scripts can post anything, so a picture is
// taken from it only as a JPEG whose size is measured here, never as posted.

jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => globalThis.crypto.randomUUID() }));
jest.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: {} }));
jest.mock('./image', () => ({ probeImageSize: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

// Twelve bytes: the sniff reads no shorter input.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SOURCES = [
  { key: 'i0', url: 'https://cdn.example/a.jpg' },
  { key: 'i1', url: 'https://cdn.example/b.jpg' },
];

// The native fallback's fetch (`expo/fetch`, not React Native's, whose Response has no stream).
// It answers nothing usable here — what is asserted is WHICH addresses it was asked for.
const fetchMock = jest.mocked(expoFetch);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Awaited<
    ReturnType<typeof expoFetch>
  >);
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

// The native fetch is this app's request, not the page's: no cookie of the site's rides on it, and
// its body is read against the ceiling through the stream, never buffered whole.
it('fetches natively without credentials, and cancels a body that passes the ceiling', async () => {
  const cancel = jest.fn(async () => undefined);
  const arrayBuffer = jest.fn(async () => {
    throw new Error('must not buffer the whole body');
  });
  let sent = 0;
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer,
    body: {
      getReader: () => ({
        read: async () => {
          sent += 1;
          return { done: false, value: new Uint8Array(READER_IMAGE_MAX_SOURCE_BYTES / 2 + 1) };
        },
        cancel,
      }),
    },
  } as unknown as Awaited<ReturnType<typeof expoFetch>>);

  const kept = await collectReaderImagesPreferring(SOURCES.slice(0, 1), new Map());

  expect(kept).toEqual([]);
  expect(fetchMock).toHaveBeenCalledWith(
    SOURCES[0].url,
    expect.objectContaining({ credentials: 'omit' }),
  );
  expect(sent).toBe(2);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(arrayBuffer).not.toHaveBeenCalled();
});

// A page names these addresses, so a response that never ends must cost a cancelled request, not
// the phone's memory: the ceiling is checked BEFORE the body is buffered.
describe('readBodyWithin', () => {
  const chunk = (n: number) => new Uint8Array(n).fill(1);
  const streamed = (chunks: Uint8Array[], headers: Record<string, string> = {}) => {
    let i = 0;
    const cancel = jest.fn(async () => undefined);
    const res = {
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length
              ? { done: false, value: chunks[i++] }
              : { done: true, value: undefined },
          cancel,
        }),
      },
      arrayBuffer: jest.fn(async () => {
        throw new Error('must not buffer the whole body');
      }),
    } as unknown as Response;
    return { res, cancel };
  };

  it('refuses on a declared length past the ceiling, reading nothing', async () => {
    const { res } = streamed([chunk(10)], { 'content-length': '1000' });

    await expect(readBodyWithin(res, 100)).resolves.toBeUndefined();
  });

  it('cancels a stream the moment it passes the ceiling, with no length declared', async () => {
    const { res, cancel } = streamed([chunk(60), chunk(60), chunk(60)]);

    await expect(readBodyWithin(res, 100)).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('returns the whole body when it fits', async () => {
    const { res } = streamed([chunk(40), chunk(40)]);

    const bytes = await readBodyWithin(res, 100);

    expect(bytes?.byteLength).toBe(80);
  });

  it('falls back to a buffered read where the response has no stream, and still enforces the ceiling', async () => {
    const buffered = (n: number) =>
      ({
        headers: { get: () => null },
        body: null,
        arrayBuffer: async () => chunk(n).buffer,
      }) as unknown as Response;

    await expect(readBodyWithin(buffered(50), 100)).resolves.toHaveLength(50);
    await expect(readBodyWithin(buffered(150), 100)).resolves.toBeUndefined();
  });
});
