import { gzipSync as nodeGzip } from 'node:zlib';

import {
  READER_DOC_MAX_JSON_BYTES,
  READER_DOC_VERSION,
  READER_STORE_MAX_BLOCKS,
  type ReaderDoc,
  utf8,
} from '@stxapps/shared';

import { decodeReaderDoc } from './reader-doc-bytes';

// The expo reader decodes copies written by OTHER platforms — today only the browser
// extension, which gzips with the web's CompressionStream. So the bytes under test
// are made by a different gzip implementation (node's zlib) than the one decoding
// them (fflate): the format is the contract, not either library.

const DOC: ReaderDoc = {
  version: READER_DOC_VERSION,
  capturedAt: 1,
  title: 'Café ☕ — 東京',
  blocks: [{ id: 'b0', kind: 'paragraph', runs: [{ text: 'Hello 👋 world' }] }],
};

it('reads a copy another gzip wrote, multi-byte text intact', () => {
  expect(decodeReaderDoc(nodeGzip(Buffer.from(JSON.stringify(DOC))))).toEqual(DOC);
});

it('answers undefined, never a throw, for bytes that are not a copy', () => {
  expect(decodeReaderDoc(utf8('not gzip'))).toBeUndefined();
  expect(decodeReaderDoc(nodeGzip(Buffer.from('{"nope":true}')))).toBeUndefined();
});

// The blob is not trusted (a backup is an outside file; on the WebView door the walker is the
// page's own code): the inflate has a ceiling, and a document that parses is held to the store
// edge's size ceilings. Either way the copy is simply unreadable.
it('stops inflating at the ceiling: a few KB of gzip cannot become a gigabyte', () => {
  // A VALID document followed by whitespace past the ceiling: it parses, and is within the size
  // caps, so only the ceiling on the inflate can refuse it.
  const padded = Buffer.alloc(READER_DOC_MAX_JSON_BYTES + 1, 0x20);
  padded.write(JSON.stringify(DOC));
  const bomb = nodeGzip(padded);
  expect(bomb.length).toBeLessThan(200 * 1024);

  expect(decodeReaderDoc(bomb)).toBeUndefined();
  // And the same document without the padding reads.
  expect(decodeReaderDoc(nodeGzip(Buffer.from(JSON.stringify(DOC))))).toEqual(DOC);
});

it('refuses a document past the store edge’s size ceilings, whoever stored it', () => {
  const blocks = Array.from({ length: READER_STORE_MAX_BLOCKS + 1 }, (_, i) => ({
    id: `b${i}`,
    kind: 'rule',
  }));

  expect(
    decodeReaderDoc(nodeGzip(Buffer.from(JSON.stringify({ ...DOC, blocks })))),
  ).toBeUndefined();
});
