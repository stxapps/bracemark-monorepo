import { gzipSync as nodeGzip } from 'node:zlib';

import { READER_DOC_VERSION, type ReaderDoc, utf8 } from '@stxapps/shared';

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
