import { READER_IMAGE_MAX_SOURCE_BYTES, READER_IMAGES_MAX_BYTES } from '@stxapps/shared';

import { encodeReaderImage } from './reader-image';
import { collectReaderImages } from './reader-images';

// Fetching one article's images. The encoder needs a canvas jsdom doesn't have, so it
// is a seam here; what is pinned is the collecting: order, the things that make an
// image simply absent, and the two limits that keep an article from waiting on its
// pictures or spending the whole budget.

jest.mock('./reader-image', () => ({ encodeReaderImage: jest.fn() }));
const mockEncode = jest.mocked(encodeReaderImage);

const sources = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `i${i}`, url: `https://cdn.example/${i}.jpg` }));
const encoded = (size: number) => ({
  bytes: new Uint8Array(size),
  type: 'image/jpeg',
  width: 800,
  height: 400,
});

beforeEach(() => {
  mockEncode.mockReset();
  mockEncode.mockImplementation(async () => encoded(10));
});

it('returns the images it could keep, in page order, each under its key', async () => {
  const fetchBytes = jest.fn(async (url: string) => {
    if (url.endsWith('/1.jpg')) return undefined; // refused
    if (url.endsWith('/2.jpg')) throw new Error('network'); // failed
    if (url.endsWith('/3.jpg')) return new Uint8Array(READER_IMAGE_MAX_SOURCE_BYTES + 1); // huge
    // Later images come back sooner: order is the page's, not arrival's.
    await new Promise((resolve) => setTimeout(resolve, url.endsWith('/0.jpg') ? 20 : 1));
    return new Uint8Array([1]);
  });
  mockEncode.mockImplementation(async (bytes) =>
    bytes.length === 1 ? encoded(10) : 'not-an-image',
  );

  const images = await collectReaderImages(sources(6), fetchBytes);

  expect(images.map((image) => image.key)).toEqual(['i0', 'i4', 'i5']);
  expect(images[0]).toMatchObject({ type: 'image/jpeg', width: 800, height: 400 });
});

it('drops an image the encoder refuses — too small, not an image, undecodable', async () => {
  mockEncode
    .mockResolvedValueOnce('too-small')
    .mockResolvedValueOnce('not-an-image')
    .mockResolvedValueOnce('undecodable')
    .mockResolvedValueOnce(encoded(10));

  const images = await collectReaderImages(sources(4), async () => new Uint8Array([1]), {
    concurrency: 1,
  });

  expect(images.map((image) => image.key)).toEqual(['i3']);
});

it('stops asking once the byte budget is spent', async () => {
  mockEncode.mockImplementation(async () => encoded(READER_IMAGES_MAX_BYTES / 2));
  const fetchBytes = jest.fn(async () => new Uint8Array([1]));

  const images = await collectReaderImages(sources(10), fetchBytes, { concurrency: 1 });

  expect(images).toHaveLength(2);
  expect(fetchBytes).toHaveBeenCalledTimes(2);
});

it('gives up at the deadline, keeping what it has — the text must not wait', async () => {
  const fetchBytes = jest.fn(
    (url: string, signal: AbortSignal) =>
      new Promise<Uint8Array | undefined>((resolve) => {
        if (url.endsWith('/0.jpg')) return resolve(new Uint8Array([1]));
        signal.addEventListener('abort', () => resolve(undefined));
      }),
  );

  const images = await collectReaderImages(sources(3), fetchBytes, {
    deadlineMs: 30,
    concurrency: 3,
  });

  expect(images.map((image) => image.key)).toEqual(['i0']);
});

it('tries no more addresses than the caller allows', async () => {
  const fetchBytes = jest.fn(async () => new Uint8Array([1]));
  await collectReaderImages(sources(10), fetchBytes, { maxCount: 3 });
  expect(fetchBytes).toHaveBeenCalledTimes(3);
});
