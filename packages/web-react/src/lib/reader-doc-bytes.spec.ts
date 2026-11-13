import {
  READER_DOC_MAX_JSON_BYTES,
  READER_DOC_VERSION,
  READER_STORE_MAX_BLOCKS,
  type ReaderDoc,
  utf8,
} from '@stxapps/shared';

import { decodeReaderDoc, encodeReaderDoc } from './reader-doc-bytes';

// The read-mode copy's byte format. Two properties are load-bearing: what goes in
// comes back out (it is the user's kept copy), and the bytes are GZIP — expo decodes
// them with fflate, not with this module, so the format is the contract, not the API.

const DOC: ReaderDoc = {
  version: READER_DOC_VERSION,
  title: 'A post',
  capturedAt: 1_700_000_000_000,
  blocks: [
    { id: 'b0', kind: 'heading', level: 1, runs: [{ text: 'A post' }] },
    { id: 'b1', kind: 'paragraph', runs: [{ text: 'Hello ' }, { text: 'world', bold: true }] },
  ],
};

it('round-trips a document', async () => {
  await expect(decodeReaderDoc(await encodeReaderDoc(DOC))).resolves.toEqual(DOC);
});

it('writes gzip, which is what every other platform has to read', async () => {
  const bytes = await encodeReaderDoc(DOC);
  expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
});

it('reads an unknown block kind and field rather than dropping the copy', async () => {
  // A newer client's document, through an older reader: it renders what it knows.
  const future = {
    ...DOC,
    blocks: [
      ...DOC.blocks,
      { id: 'b2', kind: 'poll', options: [['a']] },
      // And a KNOWN kind carrying what this version doesn't write: a table cell with
      // no runs, a row with no cells. The copy must still read (reader-doc.ts).
      { id: 'b3', kind: 'table', rows: [{ cells: [{ blocks: [] }, { runs: [] }] }, { note: 1 }] },
    ],
  } as ReaderDoc;
  await expect(decodeReaderDoc(await encodeReaderDoc(future))).resolves.toEqual(future);
});

it('answers undefined, never a throw, for bytes that are not a copy', async () => {
  await expect(decodeReaderDoc(utf8('not gzip'))).resolves.toBeUndefined();
  const notADoc = await encodeReaderDoc({ nope: true } as unknown as ReaderDoc);
  await expect(decodeReaderDoc(notADoc)).resolves.toBeUndefined();
});

// The blob is not trusted: a backup is an outside file, and on the WebView door the walker is the
// page's own code. So the inflate has a ceiling, and a document that parses is held to the store
// edge's size ceilings; either way the copy is simply unreadable, like any other bad blob.
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const piped = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

it('stops inflating at the ceiling: a few KB of gzip cannot become a gigabyte', async () => {
  // A VALID document followed by whitespace past the ceiling: it parses, and is within the size
  // caps, so only the ceiling on the inflate can refuse it.
  const padded = new Uint8Array(READER_DOC_MAX_JSON_BYTES + 1).fill(0x20);
  padded.set(utf8(JSON.stringify(DOC)));
  const bomb = await gzip(padded);
  expect(bomb.length).toBeLessThan(200 * 1024);

  await expect(decodeReaderDoc(bomb)).resolves.toBeUndefined();
  // And the same document without the padding reads.
  await expect(decodeReaderDoc(await encodeReaderDoc(DOC))).resolves.toEqual(DOC);
});

// The ceiling's point is that the rest is never produced: the stream is CANCELLED the moment it
// passes, not read to its end and thrown away. The result above is the same either way.
it('cancels the inflate at the ceiling instead of reading the bomb out', async () => {
  const cancel = jest.spyOn(ReadableStreamDefaultReader.prototype, 'cancel');
  try {
    const padded = new Uint8Array(READER_DOC_MAX_JSON_BYTES * 2).fill(0x20);
    padded.set(utf8(JSON.stringify(DOC)));

    await expect(decodeReaderDoc(await gzip(padded))).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);

    cancel.mockClear();
    await expect(decodeReaderDoc(await encodeReaderDoc(DOC))).resolves.toEqual(DOC);
    expect(cancel).not.toHaveBeenCalled();
  } finally {
    cancel.mockRestore();
  }
});

it('refuses a document past the store edge’s size ceilings, whoever stored it', async () => {
  const blocks = Array.from({ length: READER_STORE_MAX_BLOCKS + 1 }, (_, i) => ({
    id: `b${i}`,
    kind: 'rule',
  }));

  await expect(decodeReaderDoc(await encodeReaderDoc({ ...DOC, blocks }))).resolves.toBeUndefined();
});
