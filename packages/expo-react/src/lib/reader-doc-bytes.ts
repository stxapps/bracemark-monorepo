import { Gunzip } from 'fflate';

import {
  READER_DOC_MAX_JSON_BYTES,
  type ReaderDoc,
  readerDocSchema,
  readerDocWithinCaps,
} from '@stxapps/shared';

import { decodeUtf8 } from './utf8';

// The read-mode copy's bytes, decoded — the expo half of web-react
// lib/reader-doc-bytes.ts. The format is gzip over UTF-8 JSON (a `ReaderDoc`,
// @stxapps/shared reader/reader-doc.ts); web reads it with DecompressionStream, which
// Hermes doesn't have, so this reads the same bytes with fflate. Undefined — never a
// throw — for anything that isn't a readable copy, for the same reason as web's: one
// bad blob must not take the screen with it.
//
// Synchronous, on the JS thread: a copy is tens of KB compressed and a few hundred
// uncompressed at the very most (READER_DOC_MAX_CHARS bounds the walker), so the
// decode is a few ms — not worth a worklet. `decodeUtf8` rather than TextDecoder for
// the reason lib/utf8.ts gives.
//
// BOUNDED. The blob is not trusted: a backup is an outside file, and on the WebView door
// the walker is the page's own code, so a few KB of gzip can name a gigabyte. The inflate
// stops at READER_DOC_MAX_JSON_BYTES (it throws out of the callback, so the rest is never
// produced), and a copy that parses is then held to the store edge's size ceilings
// (readerDocWithinCaps). Either way: undefined, like any other unreadable copy.
function inflateWithin(bytes: Uint8Array, limit: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  const gunzip = new Gunzip((chunk) => {
    total += chunk.length;
    if (total > limit) throw new RangeError('reader copy too large');
    parts.push(chunk);
  });
  gunzip.push(bytes, true);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function decodeReaderDoc(bytes: Uint8Array): ReaderDoc | undefined {
  try {
    const parsed = readerDocSchema.safeParse(
      JSON.parse(decodeUtf8(inflateWithin(bytes, READER_DOC_MAX_JSON_BYTES))),
    );
    return parsed.success && readerDocWithinCaps(parsed.data) ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
