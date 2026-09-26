// UTF-8 bytes → string, for the data path's hot decodes on Hermes: every stored
// blob the read edge, the projector and export decode (data/projection.ts
// `parseBlob`), and an import's whole file.
//
// Why not `TextDecoder`: Hermes has none, and the one Expo's winter runtime
// installs (node_modules/expo/src/winter/TextDecoder.ts) is a pure-JS port of
// the text-encoding polyfill. It copies the input into a reversed token array,
// pops it a byte at a time through a handler object, and builds the result with
// `+=` per character. A Hermes profile of a 1,000-link CSV export put 235 ms of
// its 279 ms of blob decoding in that decoder, with the JSON parse and schema
// check in the remainder (docs/data-lifecycle.md, _readings — expo_). This is
// the same algorithm without the overhead: one pass over the bytes into a
// reused code-unit buffer, flushed through `String.fromCharCode` a chunk at a
// time.
//
// The output is `new TextDecoder().decode(bytes)`'s, exactly: WHATWG UTF-8 with
// replacement (an invalid or truncated sequence becomes U+FFFD, never an
// exception) and a leading BOM stripped. utf8.spec.ts holds it to Node's
// decoder over fixed cases and random bytes. Web keeps its native decoder
// (@stxapps/shared `bytesToUtf8`); this module is only worth having where the
// runtime's own is slow.

// Code units per `String.fromCharCode.apply` — under every engine's argument
// limit, large enough that the calls are few.
const CHUNK = 0x2000;
const REPLACEMENT = 0xfffd;

export function decodeUtf8(bytes: Uint8Array): string {
  const length = bytes.length;
  // One spare slot, so a surrogate pair written at the boundary always fits.
  const units = new Uint16Array(CHUNK + 1);
  const parts: string[] = [];
  let count = 0;
  const flush = () => {
    parts.push(String.fromCharCode.apply(null, units.subarray(0, count) as unknown as number[]));
    count = 0;
  };

  let i = 0;
  if (length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;

  // The WHATWG decoder's state: continuation bytes still needed and seen, the
  // code point so far, and the bounds the next continuation byte must fall in
  // (narrowed after E0, ED, F0 and F4, which is what rejects overlongs,
  // surrogates and code points past U+10FFFF).
  let needed = 0;
  let seen = 0;
  let codePoint = 0;
  let lower = 0x80;
  let upper = 0xbf;

  while (i < length) {
    const byte = bytes[i];
    if (needed === 0) {
      i++;
      if (byte <= 0x7f) {
        units[count++] = byte;
      } else if (byte >= 0xc2 && byte <= 0xdf) {
        needed = 1;
        codePoint = byte & 0x1f;
      } else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) lower = 0xa0;
        else if (byte === 0xed) upper = 0x9f;
        needed = 2;
        codePoint = byte & 0x0f;
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) lower = 0x90;
        else if (byte === 0xf4) upper = 0x8f;
        needed = 3;
        codePoint = byte & 0x07;
      } else {
        units[count++] = REPLACEMENT;
      }
    } else if (byte < lower || byte > upper) {
      // A broken sequence: one U+FFFD for what came before, and this byte is
      // read again as the start of whatever follows (so no `i++`).
      needed = seen = codePoint = 0;
      lower = 0x80;
      upper = 0xbf;
      units[count++] = REPLACEMENT;
    } else {
      i++;
      lower = 0x80;
      upper = 0xbf;
      codePoint = (codePoint << 6) | (byte & 0x3f);
      if (++seen === needed) {
        if (codePoint > 0xffff) {
          codePoint -= 0x10000;
          units[count++] = 0xd800 + (codePoint >> 10);
          units[count++] = 0xdc00 + (codePoint & 0x3ff);
        } else {
          units[count++] = codePoint;
        }
        needed = seen = codePoint = 0;
      }
    }
    if (count >= CHUNK) flush();
  }
  // Input that ends mid-sequence.
  if (needed !== 0) units[count++] = REPLACEMENT;
  if (count > 0 || parts.length === 0) flush();
  return parts.length === 1 ? parts[0] : parts.join('');
}
