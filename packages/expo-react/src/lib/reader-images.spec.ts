import { fetch as expoFetch } from 'expo/fetch';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator } from 'expo-image-manipulator';

import { READER_IMAGE_MAX_DIMENSION, READER_IMAGE_MAX_SOURCE_BYTES } from '@stxapps/shared';

import { probeImageSize } from './image';
import { collectReaderImagesPreferring, streamBodyTo } from './reader-images';

// The capture screen's image collection: the bytes the PAGE fetched and encoded, where
// they are what web-react's encoder writes, and a native fetch for every other address.
// What matters is the boundary — a page's scripts can post anything, so a picture is
// taken from it only as a JPEG whose size is measured here, never as posted.

jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => globalThis.crypto.randomUUID() }));
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: jest.fn() },
  SaveFormat: { JPEG: 'jpeg' },
}));
jest.mock('./image', () => ({ probeImageSize: jest.fn() }));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const { listFileUris, resetFileSystem } = require('../testing/memory-file-system') as {
  listFileUris: () => string[];
  resetFileSystem: () => void;
};

// The headers a decoder would be handed: enough of each format for `imageHeaderSize`,
// which runs before any decoder does. A JPEG: SOI, a JFIF APP0, then the frame header.
function jpegOf(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    16,
    0x4a,
    0x46,
    0x49,
    0x46,
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    0xff,
    0xc0,
    0,
    17,
    8,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ]);
}
// A PNG's signature and IHDR.
function pngOf(width: number, height: number): Uint8Array {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  new DataView(png.buffer).setUint32(16, width);
  new DataView(png.buffer).setUint32(20, height);
  return png;
}
const JPEG = jpegOf(640, 320);
const PNG = pngOf(640, 320);
const SOURCES = [
  { key: 'i0', url: 'https://cdn.example/a.jpg' },
  { key: 'i1', url: 'https://cdn.example/b.jpg' },
];

// The native fallback's fetch (`expo/fetch`, not React Native's, whose Response has no stream).
// It answers nothing usable here — what is asserted is WHICH addresses it was asked for.
const fetchMock = jest.mocked(expoFetch);

type FetchResponse = Awaited<ReturnType<typeof expoFetch>>;

// A 200 whose body streams `bytes` in two chunks.
function okStreaming(bytes: Uint8Array): FetchResponse {
  const chunks = [bytes.subarray(0, 6), bytes.subarray(6)];
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => {
      throw new Error('must not buffer the whole body');
    },
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: chunks[i++] }
            : { done: true, value: undefined },
        cancel: async () => undefined,
      }),
    },
  } as unknown as FetchResponse;
}

// The manipulator writes its JPEG where the real one does, and reports a 1024-wide result.
const manipulateMock = jest.mocked(ImageManipulator.manipulate);
let saves = 0;

beforeEach(() => {
  resetFileSystem();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as FetchResponse);
  jest.mocked(probeImageSize).mockReset();
  jest.mocked(probeImageSize).mockResolvedValue({ width: 640, height: 320 });
  manipulateMock.mockReset();
  manipulateMock.mockImplementation(
    () =>
      ({
        resize: jest.fn(),
        renderAsync: async () => ({
          saveAsync: async () => {
            const out = new File(Paths.cache, 'ImageManipulator', `out-${(saves += 1)}.jpg`);
            out.create({ intermediates: true, overwrite: true });
            out.write(jpegOf(1024, 512));
            return { uri: out.uri, width: 1024, height: 512 };
          },
        }),
      }) as unknown as ReturnType<typeof ImageManipulator.manipulate>,
  );
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

// What no decoder may be handed, and how many may decode at once — the two rules in the
// collector's header. Both are about the phone's memory, so neither shows as a failure.
describe('the decode', () => {
  it('never opens an image whose header claims past the pixel ceiling', async () => {
    // A small file that would decode to 1.6 GB.
    fetchMock.mockResolvedValue(okStreaming(pngOf(20000, 20000)));

    const kept = await collectReaderImagesPreferring(SOURCES.slice(0, 1), new Map());

    expect(kept).toEqual([]);
    expect(probeImageSize).not.toHaveBeenCalled();
    expect(manipulateMock).not.toHaveBeenCalled();
  });

  it('never opens one it cannot size, though the sniff took it', async () => {
    fetchMock.mockResolvedValue(okStreaming(PNG.subarray(0, 16)));

    await collectReaderImagesPreferring(SOURCES.slice(0, 1), new Map());

    expect(probeImageSize).not.toHaveBeenCalled();
  });

  it('refuses a page’s JPEG past the dimension cap by its header, without probing it', async () => {
    const kept = await collectReaderImagesPreferring(
      SOURCES.slice(0, 1),
      new Map([['i0', jpegOf(20000, 20000)]]),
    );

    expect(kept).toEqual([]);
    expect(probeImageSize).not.toHaveBeenCalled();
  });

  it('decodes one image at a time while the fetches overlap, and stores each', async () => {
    const sources = [0, 1, 2].map((n) => ({ key: `i${n}`, url: `https://cdn.example/${n}.png` }));
    fetchMock.mockImplementation(async () => okStreaming(pngOf(2048, 1024)));
    let decoding = 0;
    let most = 0;
    jest.mocked(probeImageSize).mockImplementation(async () => {
      decoding += 1;
      most = Math.max(most, decoding);
      await new Promise((resolve) => setTimeout(resolve, 5));
      decoding -= 1;
      return { width: 2048, height: 1024 };
    });

    const kept = await collectReaderImagesPreferring(sources, new Map());

    expect(most).toBe(1);
    expect(kept.map((entry) => [entry.key, entry.width, entry.height])).toEqual([
      ['i0', 1024, 512],
      ['i1', 1024, 512],
      ['i2', 1024, 512],
    ]);
    // Every scratch file and every manipulator output is gone once the article is done.
    expect(listFileUris()).toEqual([]);
  });

  it('keeps an original JPEG the re-encode did not make smaller, read back off the file', async () => {
    // Within the cap, so no resize; and shorter than the manipulator's output.
    fetchMock.mockResolvedValue(okStreaming(JPEG));

    const kept = await collectReaderImagesPreferring(SOURCES.slice(0, 1), new Map());

    expect(kept).toEqual([{ key: 'i0', type: 'image/jpeg', width: 640, height: 320, bytes: JPEG }]);
  });
});

// A page names these addresses, so a response that never ends must cost a cancelled request, not
// the phone's memory: the ceiling is checked BEFORE the body is kept, and what is kept goes to
// the file a chunk at a time, with only its head in memory.
describe('streamBodyTo', () => {
  const chunk = (n: number, fill = 1) => new Uint8Array(n).fill(fill);
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
  const scratch = () => new File(Paths.cache, 'body');

  it('refuses on a declared length past the ceiling, reading nothing', async () => {
    const { res } = streamed([chunk(10)], { 'content-length': '1000' });

    await expect(streamBodyTo(res, 100, scratch())).resolves.toBeUndefined();
  });

  it('cancels a stream the moment it passes the ceiling, with no length declared', async () => {
    const { res, cancel } = streamed([chunk(60), chunk(60), chunk(60)]);

    await expect(streamBodyTo(res, 100, scratch())).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('writes the whole body to the file, and hands back its head and length', async () => {
    const { res } = streamed([chunk(40, 1), chunk(40, 2)]);
    const file = scratch();

    const body = await streamBodyTo(res, 100, file);

    expect(body?.size).toBe(80);
    expect(body?.head).toEqual(new Uint8Array([...chunk(40, 1), ...chunk(40, 2)]));
    await expect(file.bytes()).resolves.toEqual(body?.head);
  });

  it('keeps only the head in memory once the body runs past it', async () => {
    const head = 256 * 1024;
    const { res } = streamed([chunk(head - 10, 1), chunk(30, 2), chunk(head, 3)]);
    const file = scratch();

    const body = await streamBodyTo(res, 8 * 1024 * 1024, file);

    expect(body?.size).toBe(2 * head + 20);
    expect(body?.head.byteLength).toBe(head);
    expect(body?.head[head - 1]).toBe(2);
    expect(file.size).toBe(2 * head + 20);
  });

  it('falls back to a buffered read where the response has no stream, and still enforces the ceiling', async () => {
    const buffered = (n: number) =>
      ({
        headers: { get: () => null },
        body: null,
        arrayBuffer: async () => chunk(n).buffer,
      }) as unknown as Response;

    await expect(streamBodyTo(buffered(50), 100, scratch())).resolves.toMatchObject({ size: 50 });
    await expect(streamBodyTo(buffered(150), 100, scratch())).resolves.toBeUndefined();
  });
});
