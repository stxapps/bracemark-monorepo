import { gunzipSync } from 'fflate';

import { type ReaderDoc, readerDocSchema } from '@stxapps/shared';

import { decodeUtf8 } from './utf8';

// The read-mode copy's bytes, decoded — the expo half of web-react
// lib/reader-doc-bytes.ts. The format is gzip over UTF-8 JSON (a `ReaderDoc`,
// @stxapps/shared reader/reader-doc.ts); web reads it with DecompressionStream, which
// Hermes doesn't have, so this reads the same bytes with fflate. Undefined — never a
// throw — for anything that isn't a readable copy, for the same reason as web's: one
// bad blob must not take the screen with it.
//
// Synchronous, on the JS thread: a copy is tens of KB compressed and a few hundred
// uncompressed at the very most (READER_DOC_MAX_CHARS bounds the capture), so the
// decode is a few ms — not worth a worklet. `decodeUtf8` rather than TextDecoder for
// the reason lib/utf8.ts gives.
export function decodeReaderDoc(bytes: Uint8Array): ReaderDoc | undefined {
  try {
    const parsed = readerDocSchema.safeParse(JSON.parse(decodeUtf8(gunzipSync(bytes))));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
