import type { ReaderDoc } from './reader-doc';
import { READER_IMAGES_MAX_BYTES, READER_IMAGES_MAX_COUNT } from './reader-doc-core';
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
      image('i0', [1, 2, 3]),
      { ...image('i1', [], 10, 20), type: 'image/png' },
      image('i2', [9, 8, 7, 6], 1024, 300),
    ];

    const decoded = decodeReaderImages(encodeReaderImages(entries));

    expect(decoded).toEqual(entries);
  });

  it('starts with its magic and version, so a reader can tell what it is holding', () => {
    const pack = encodeReaderImages([image('i0', [1])]);
    expect(String.fromCharCode(...pack.subarray(0, 4))).toBe('BMRI');
    expect(pack[4]).toBe(1);
  });

  it('decodes a pack that is a VIEW into a larger buffer', () => {
    // How it arrives on expo: bytes read off disk are not guaranteed to start at
    // offset 0 of their buffer, and a DataView built on the buffer alone reads the
    // wrong four bytes.
    const pack = encodeReaderImages([image('i0', [5, 6])]);
    const padded = new Uint8Array(pack.length + 7);
    padded.set(pack, 7);

    expect(decodeReaderImages(padded.subarray(7))).toEqual([image('i0', [5, 6])]);
  });

  it('answers undefined, never a throw, for bytes that are not a pack it can read', () => {
    const pack = encodeReaderImages([image('i0', [1, 2, 3])]);
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
