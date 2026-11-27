// An image's pixel size READ FROM ITS HEADER — no decoder, no platform API —
// for one question asked before any decoder is handed bytes a stranger chose: how
// much memory will decoding this take?
//
// The answer can't come from the decoders themselves. Every native path that keeps
// a fetched image (an article's figures, a page's preview) decodes it at FULL
// resolution before anything can refuse it: expo-image-manipulator's loader takes no
// target size, and on Android even `probeImageSize` (React Native's `Image.getSize`)
// is a full Fresco decode, not a header read. A byte ceiling doesn't bound that: a
// 100 KB PNG of one colour can be 20000 × 20000, which is 1.6 GB of pixels at four
// bytes each — memory a phone may not have to give, spent on a picture that ends up
// 1024 px wide. (The 2.5 GB Android emulator survived one on 2026-11-18; a smaller
// phone, or three at once, need not.) So the size is read here, from the same
// bytes `sniffImageMime` checks, and IMAGE_MAX_DECODE_PIXELS refuses what no
// decoder should be asked to open.
//
// Covers exactly the formats `sniffImageMime` accepts. Undefined when the header is
// not all there (`bytes` may be only the head of a longer file — read more and ask
// again), is malformed, or claims a zero side: a caller refuses an image it can't
// size, since a decoder would fail on most of those anyway.
//
// The size is the STORED one: a JPEG's EXIF orientation is not applied, so a
// rotated photo's width and height come back swapped. The area — which is what the
// ceiling is about — is the same either way; anything that lays the image out still
// measures it with a decoder, after this has let it through.

// 32 Mi pixels — an output bitmap of 128 MiB at four bytes a pixel. That is what it
// bounds, not a decode's whole peak: a progressive or CMYK JPEG also needs the
// decoder's coefficient buffers (several bytes a pixel more), and a decoder may hold
// the encoded bytes beside it. Past a 24 MP phone photo (~5–7 MB), and far past
// anything an article or a preview needs, since both are cut to 1024 px; a 48 MP photo
// small enough for the 8 MB source ceilings is refused, which fails safe.
export const IMAGE_MAX_DECODE_PIXELS = 32 * 1024 * 1024;

export interface ImageHeaderSize {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
// `>>> 0` keeps a top bit set from reading as negative.
const u32be = (b: Uint8Array, i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b: Uint8Array, i: number) =>
  (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const i32le = (b: Uint8Array, i: number) =>
  b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

const sized = (width: number, height: number): ImageHeaderSize | undefined =>
  width > 0 && height > 0 ? { width, height } : undefined;

function pngSize(b: Uint8Array, at = 0): ImageHeaderSize | undefined {
  // Signature (8), then the IHDR chunk's length (4) and type (4), then width, height.
  if (b.length < at + 24) return undefined;
  if (b[at + 12] !== 0x49 || b[at + 13] !== 0x48 || b[at + 14] !== 0x44 || b[at + 15] !== 0x52) {
    return undefined;
  }
  return sized(u32be(b, at + 16), u32be(b, at + 20));
}

// The largest canvas any decoder will draw on: the logical screen, grown to hold every
// frame's rectangle. The screen alone is not a bound — a GIF may say 1 × 1 and carry a
// 20000 × 20000 frame, and Skia (Android) grows its canvas to the first frame while
// Glide sizes a buffer by each frame. So every image descriptor is read: the walk skips
// colour tables and data sub-blocks by their lengths (a few hundred steps per KB of
// picture, no copying), and is undefined when the bytes end before the trailer — a
// caller holding only the head of the download reads the rest and asks again.
function gifSize(b: Uint8Array): ImageHeaderSize | undefined {
  if (b.length < 13) return undefined;
  let width = u16le(b, 6);
  let height = u16le(b, 8);
  const tableSize = (flags: number) => (flags & 0x80 ? 3 * (2 << (flags & 0x07)) : 0);
  // Past a run of data sub-blocks starting at `at` (each a length byte, then that many
  // bytes; a zero length ends the run); -1 when the bytes end first.
  const pastSubBlocks = (at: number): number => {
    let i = at;
    while (i < b.length) {
      const length = b[i];
      if (length === 0) return i + 1;
      i += 1 + length;
    }
    return -1;
  };

  let i = 13 + tableSize(b[10]);
  for (;;) {
    if (i >= b.length) return undefined;
    const block = b[i];
    if (block === 0x3b) return sized(width, height); // the trailer
    if (block === 0x21) {
      // An extension: its label, then its sub-blocks.
      const next = pastSubBlocks(i + 2);
      if (next === -1) return undefined;
      i = next;
    } else if (block === 0x2c) {
      // An image descriptor: left, top, width, height, flags; then its colour table, the
      // LZW code size and the picture's sub-blocks.
      if (i + 10 > b.length) return undefined;
      width = Math.max(width, u16le(b, i + 1) + u16le(b, i + 5));
      height = Math.max(height, u16le(b, i + 3) + u16le(b, i + 7));
      const next = pastSubBlocks(i + 10 + tableSize(b[i + 9]) + 1);
      if (next === -1) return undefined;
      i = next;
    } else {
      return undefined; // not a GIF block: malformed
    }
  }
}

// A BMP's DIB header, at `at` — in a BMP file after its 14-byte file header, in an
// ICO entry at the entry's offset.
function dibSize(b: Uint8Array, at: number, halfHeight: boolean): ImageHeaderSize | undefined {
  if (b.length < at + 4) return undefined;
  const headerSize = u32le(b, at);
  let width: number;
  let height: number;
  if (headerSize === 12) {
    // BITMAPCOREHEADER: 16-bit sides.
    if (b.length < at + 8) return undefined;
    width = u16le(b, at + 4);
    height = u16le(b, at + 6);
  } else {
    if (b.length < at + 12) return undefined;
    width = i32le(b, at + 4);
    // Negative for a top-down bitmap.
    height = Math.abs(i32le(b, at + 8));
  }
  // An ICO's bitmap carries its AND mask below the image, counted in the height.
  return sized(width, halfHeight ? Math.floor(height / 2) : height);
}

function bmpSize(b: Uint8Array): ImageHeaderSize | undefined {
  return dibSize(b, 14, false);
}

// The largest image the icon holds — a decoder picks one, and which is its own
// business. Measured from each image's OWN header, not the directory's bytes: the
// directory can only say up to 256 (0 means 256), and an embedded PNG can be any size.
function icoSize(b: Uint8Array): ImageHeaderSize | undefined {
  if (b.length < 6) return undefined;
  const count = u16le(b, 4);
  if (count === 0) return undefined;
  let largest: ImageHeaderSize | undefined;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    if (b.length < entry + 16) return undefined;
    const offset = u32le(b, entry + 12);
    if (b.length < offset + 8) return undefined;
    const isPng = b[offset] === 0x89 && b[offset + 1] === 0x50 && b[offset + 2] === 0x4e;
    const size = isPng ? pngSize(b, offset) : dibSize(b, offset, true);
    if (!size) return undefined;
    if (!largest || size.width * size.height > largest.width * largest.height) largest = size;
  }
  return largest;
}

function webpSize(b: Uint8Array): ImageHeaderSize | undefined {
  if (b.length < 30) return undefined;
  const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
  if (chunk === 'VP8X') {
    // The extended format's canvas, 24 bits a side, stored minus one.
    return sized(u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return undefined;
    // 14 bits each, minus one, packed little-endian after the signature byte.
    const bits = u32le(b, 21);
    return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8 ') {
    // A key frame's start code, then 14-bit sides (the top two bits are scaling).
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return undefined;
    return sized(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  return undefined;
}

// The start-of-frame markers: C0–CF, less DHT (C4), JPG (C8) and DAC (CC), which
// share the range and carry no frame.
const isStartOfFrame = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpegSize(b: Uint8Array): ImageHeaderSize | undefined {
  // Walk the segments from after SOI to the first frame header. Metadata (EXIF, ICC,
  // XMP) comes first and can run to many kilobytes, which is why a caller may need
  // more than the first chunk of a download.
  let i = 2;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1];
    // Fill bytes: any number of 0xFF before a marker.
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Markers with no length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    // End of image, or the scan, before any frame header: not one this can size.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(b, i + 2);
    if (length < 2) return undefined;
    if (isStartOfFrame(marker)) {
      if (i + 9 > b.length) return undefined;
      // Length (2), precision (1), then height and width. A height of 0 defers to a
      // DNL segment after the scan — rare, and refused like any unsized image.
      return sized(u16be(b, i + 7), u16be(b, i + 5));
    }
    i += 2 + length;
  }
  return undefined;
}

export function imageHeaderSize(bytes: Uint8Array): ImageHeaderSize | undefined {
  const b = bytes;
  if (b.length < 12) return undefined;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return pngSize(b);
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return icoSize(b);
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return gifSize(b);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpegSize(b);
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return webpSize(b);
  }
  if (b[0] === 0x42 && b[1] === 0x4d) return bmpSize(b);
  return undefined;
}

// May these bytes be handed to a decoder? Only an image whose header gives a size,
// and whose area is within IMAGE_MAX_DECODE_PIXELS.
export function isImageDecodable(size: ImageHeaderSize | undefined): size is ImageHeaderSize {
  return size !== undefined && size.width * size.height <= IMAGE_MAX_DECODE_PIXELS;
}
