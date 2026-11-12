import type { ReaderDoc } from './reader-doc';
import {
  READER_IMAGES_MAX_BYTES,
  READER_IMAGES_MAX_COUNT,
  READER_IMAGES_MAX_INDEX_BYTES,
} from './reader-doc-core';
import {
  applyReaderImages,
  decodeReaderImages,
  encodeReaderImages,
  type ReaderImageEntry,
  readerImageKeys,
  withinReaderImageBudget,
} from './reader-images';

// The read-mode copy's image pack, and the step that ties a document to it. Three
// things nothing else would notice going wrong:
//
//   - the byte format is the CONTRACT between platforms — web writes a pack expo reads
//     and the other way round, each with its own code path to these two functions;
//   - a pack is stored bytes, so a bad one must be an answer (undefined), never a
//     throw that takes the reader down;
//   - a document must never name a picture its pack doesn't hold.

// A JPEG as far as the type sniff can tell (its magic, 12 bytes), with `tail` after it. The pack's
// reader takes an entry's type from the bytes, so a fixture must look like what it claims.
const jpeg = (...tail: number[]): number[] => [
  0xff,
  0xd8,
  0xff,
  0xe0,
  0,
  0x10,
  0x4a,
  0x46,
  0x49,
  0x46,
  0,
  1,
  ...tail,
];
const png = (...tail: number[]): number[] => [
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0,
  0,
  0,
  13,
  ...tail,
];

const image = (key: string, bytes: number[], width = 800, height = 400): ReaderImageEntry => ({
  key,
  type: 'image/jpeg',
  width,
  height,
  bytes: new Uint8Array(bytes),
});

describe('the pack', () => {
  it('round-trips every image, in order, with its size and type', () => {
    const entries = [
      image('i0', jpeg(1, 2, 3)),
      { ...image('i1', png(), 10, 20), type: 'image/png' },
      image('i2', jpeg(9, 8, 7, 6), 1024, 300),
    ];

    const decoded = decodeReaderImages(encodeReaderImages(entries));

    expect(decoded).toEqual(entries);
  });

  it('starts with its magic and version, so a reader can tell what it is holding', () => {
    const pack = encodeReaderImages([image('i0', jpeg())]);
    expect(String.fromCharCode(...pack.subarray(0, 4))).toBe('BMRI');
    expect(pack[4]).toBe(1);
  });

  it('decodes a pack that is a VIEW into a larger buffer', () => {
    // How it arrives on expo: bytes read off disk are not guaranteed to start at
    // offset 0 of their buffer, and a DataView built on the buffer alone reads the
    // wrong four bytes.
    const pack = encodeReaderImages([image('i0', jpeg(5, 6))]);
    const padded = new Uint8Array(pack.length + 7);
    padded.set(pack, 7);

    expect(decodeReaderImages(padded.subarray(7))).toEqual([image('i0', jpeg(5, 6))]);
  });

  it('answers undefined, never a throw, for bytes that are not a pack it can read', () => {
    const pack = encodeReaderImages([image('i0', jpeg(1, 2, 3))]);
    const newer = pack.slice();
    newer[4] = 2;

    for (const bytes of [
      new Uint8Array(0),
      new Uint8Array([1, 2, 3]),
      new TextEncoder().encode('<html>not a pack</html>'),
      newer,
      // An image's bytes cut off the end: the index promises more than there is.
      pack.subarray(0, pack.length - 1),
      // The index itself cut short.
      pack.subarray(0, 12),
    ]) {
      expect(decodeReaderImages(bytes)).toBeUndefined();
    }
  });

  // The pack's index is data from a backup or another device. A reader mints a Blob (web) or a
  // data URI (Expo) of the entry's type, so the type is what the bytes ARE, and an entry that is
  // not a raster image does not come out at all: `text/html` in an index must never become a
  // document in the app's own origin.
  it('takes an entry’s type from its bytes, never from the index, and drops what is not a raster', () => {
    const forged = encodeReaderImages([
      { ...image('i0', jpeg(1)), type: 'text/html' },
      {
        ...image('i1', [...new TextEncoder().encode('<html><script>x</script></html>')]),
        type: 'image/jpeg',
      },
      {
        ...image('i2', [...new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')]),
        type: 'image/svg+xml',
      },
      { ...image('i3', png(7)), type: 'application/javascript' },
    ]);

    const decoded = decodeReaderImages(forged);

    expect(decoded?.map(({ key, type }) => [key, type])).toEqual([
      ['i0', 'image/jpeg'],
      ['i3', 'image/png'],
    ]);
  });

  // Bounds a writer never exceeds (the count and byte budget, ~100 bytes of index an image).
  // Past them the pack is a pack this build will not read, so a hostile one cannot ask a reader
  // for thousands of Blobs, a multi-megabyte index string or a gigabyte of images.
  it('answers undefined for a pack past the count, the byte budget or the index ceiling', () => {
    const tooMany = Array.from({ length: READER_IMAGES_MAX_COUNT + 1 }, (_, i) =>
      image(`i${i}`, jpeg()),
    );
    expect(decodeReaderImages(encodeReaderImages(tooMany))).toBeUndefined();

    const tooBig = encodeReaderImages([
      { ...image('i0', []), bytes: new Uint8Array(READER_IMAGES_MAX_BYTES + 1).fill(0xff) },
    ]);
    expect(decodeReaderImages(tooBig)).toBeUndefined();

    const fat = encodeReaderImages([image('x'.repeat(READER_IMAGES_MAX_INDEX_BYTES), jpeg())]);
    expect(decodeReaderImages(fat)).toBeUndefined();

    // And the honest maximum still reads.
    const atTheLimit = Array.from({ length: READER_IMAGES_MAX_COUNT }, (_, i) =>
      image(`i${i}`, jpeg(i)),
    );
    expect(decodeReaderImages(encodeReaderImages(atTheLimit))).toHaveLength(
      READER_IMAGES_MAX_COUNT,
    );
  });

  it('refuses to write an index that is not ASCII, which it could not read back', () => {
    expect(() => encodeReaderImages([image('clé', [1])])).toThrow('ASCII');
  });
});

describe('applyReaderImages', () => {
  const doc = (blocks: ReaderDoc['blocks']): ReaderDoc => ({ version: 1, capturedAt: 0, blocks });
  const captured = doc([
    { id: 'b0', kind: 'paragraph', runs: [{ text: 'Before.' }] },
    { id: 'b1', kind: 'figure', text: 'A chart', image: 'i0' },
    { id: 'b2', kind: 'figure', text: 'A photo', image: 'i1' },
    { id: 'b3', kind: 'figure', image: 'i2' },
    { id: 'b4', kind: 'figure', text: 'No address' },
  ]);

  it('gives a kept figure its stored size and takes the key off the rest', () => {
    const settled = applyReaderImages(captured, new Map([['i0', { width: 640, height: 320 }]]));

    expect(settled.blocks).toEqual([
      { id: 'b0', kind: 'paragraph', runs: [{ text: 'Before.' }] },
      { id: 'b1', kind: 'figure', text: 'A chart', image: 'i0', width: 640, height: 320 },
      // Not kept, but it has words: the placeholder it would be with images off.
      { id: 'b2', kind: 'figure', text: 'A photo' },
      // b3 had nothing but its picture, so there is nothing left of it to show.
      { id: 'b4', kind: 'figure', text: 'No address' },
    ]);
    expect(readerImageKeys(settled)).toEqual(['i0']);
  });

  it('with nothing kept, leaves a document that names no picture at all', () => {
    // What every capture with images OFF stores: a document that carried keys out of
    // the walker and must not carry them into storage.
    const settled = applyReaderImages(captured, new Map());

    expect(readerImageKeys(settled)).toEqual([]);
    expect(JSON.stringify(settled)).not.toMatch(/"image"|"width"|"height"/);
    expect(captured.blocks[1].image).toBe('i0'); // the input is not mutated
  });
});

describe('withinReaderImageBudget', () => {
  it('takes images in page order until the count is spent', () => {
    const many = Array.from({ length: READER_IMAGES_MAX_COUNT + 5 }, (_, i) => image(`i${i}`, [1]));
    const taken = withinReaderImageBudget(many);
    expect(taken).toHaveLength(READER_IMAGES_MAX_COUNT);
    expect(taken[0].key).toBe('i0');
  });

  it('stops at the first image that does not fit, rather than skipping to one that does', () => {
    const big = { ...image('i1', []), bytes: new Uint8Array(READER_IMAGES_MAX_BYTES) };
    const taken = withinReaderImageBudget([image('i0', [1]), big, image('i2', [1])]);
    // i2 would fit, but it is past the point the article's pictures stop.
    expect(taken.map((entry) => entry.key)).toEqual(['i0']);
  });
});
