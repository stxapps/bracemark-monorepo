import { READER_DOC_VERSION, type ReaderDoc, utf8 } from '@stxapps/shared';

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
    blocks: [...DOC.blocks, { id: 'b2', kind: 'table', rows: [['a']] }],
  } as ReaderDoc;
  await expect(decodeReaderDoc(await encodeReaderDoc(future))).resolves.toEqual(future);
});

it('answers undefined, never a throw, for bytes that are not a copy', async () => {
  await expect(decodeReaderDoc(utf8('not gzip'))).resolves.toBeUndefined();
  const notADoc = await encodeReaderDoc({ nope: true } as unknown as ReaderDoc);
  await expect(decodeReaderDoc(notADoc)).resolves.toBeUndefined();
});
