// The icon verdict both platforms' fillers share. Beyond "is it an image", the
// two things this file exists to pin are the ones the platforms disagreed on
// before it was hoisted: the CAP (web had only the extractor's 10 MB proxy
// ceiling, which is not a statement about icons) and the SVG MIME (web renders
// through an `<img>` object URL, which content-sniffs raster but not SVG).

import { sniffImageMime } from '../image/sniff';
import {
  FAVICON_MAX_DECODE_PIXELS,
  isOversizedRasterIcon,
  isRenderableIconBytes,
  MAX_FAVICON_BYTES,
  sniffIconMime,
} from './favicon';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
// A PNG's signature and IHDR, 16 × 16: the filler's verdict reads the size from it.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 16,
  0, 0, 0, 16,
]);
// The same header claiming 20000 × 20000 — what a 76 KB PNG can say.
const HUGE_PNG = Uint8Array.from(PNG);
HUGE_PNG.set([0, 0, 0x4e, 0x20, 0, 0, 0x4e, 0x20], 16);

describe('sniffIconMime', () => {
  it('reports the raster mime', () => {
    expect(sniffIconMime(PNG)).toBe('image/png');
    expect(sniffIconMime(new Uint8Array([0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'image/x-icon',
    );
  });

  it('reports image/svg+xml — the mime web has to declare for an <img> to paint it', () => {
    expect(sniffIconMime(utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      'image/svg+xml',
    );
  });

  it('refuses a page and an empty body', () => {
    expect(
      sniffIconMime(utf8('<!DOCTYPE html><html><body>Not found</body></html>')),
    ).toBeUndefined();
    expect(sniffIconMime(new Uint8Array(0))).toBeUndefined();
  });

  it('refuses valid image bytes past the cap — that is not an icon', () => {
    const oversized = new Uint8Array(MAX_FAVICON_BYTES + 1);
    oversized.set(PNG);
    // Only meaningful because these bytes would otherwise PASS: without this the
    // assertion below would prove nothing about the cap.
    expect(sniffImageMime(oversized)).toBe('image/png');
    expect(sniffIconMime(oversized)).toBeUndefined();
    // And exactly at the cap it still passes — the bound is inclusive.
    const atCap = new Uint8Array(MAX_FAVICON_BYTES);
    atCap.set(PNG);
    expect(sniffIconMime(atCap)).toBe('image/png');
  });
});

describe('isRenderableIconBytes', () => {
  it('is the wider verdict: raster OR svg', () => {
    expect(isRenderableIconBytes(PNG)).toBe(true);
    expect(isRenderableIconBytes(utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe(
      true,
    );
  });

  it('inherits the cap, not just the sniffs', () => {
    // This is the verdict EXPO gates its cache on, and expo's fetch has no ceiling
    // in front of it (no proxy, and RN's fetch can't stream-abort) — so a boolean
    // that asked only "is it an image" would write a multi-megabyte body into
    // db.favicons, where `ok` rows never expire. Delegating to sniffIconMime is what
    // keeps the two verdicts one verdict; nothing else says so.
    const oversized = new Uint8Array(MAX_FAVICON_BYTES + 1);
    oversized.set(PNG);
    expect(isRenderableIconBytes(oversized)).toBe(false);
  });

  // The byte cap doesn't bound a decode; the header does (FAVICON_MAX_DECODE_PIXELS).
  it('refuses a raster icon that decodes past the ceiling, or whose size it cannot read', () => {
    expect(sniffIconMime(HUGE_PNG)).toBe('image/png'); // the render-time sniff still takes it
    expect(isRenderableIconBytes(HUGE_PNG)).toBe(false);
    const atCeiling = Uint8Array.from(PNG);
    atCeiling.set([0, 0, 0x08, 0x00, 0, 0, 0x08, 0x00], 16); // 2048 × 2048
    expect(isRenderableIconBytes(atCeiling)).toBe(true);
    const pastCeiling = Uint8Array.from(PNG);
    pastCeiling.set([0, 0, 0x08, 0x00, 0, 0, 0x08, 0x01], 16); // 2048 × 2049
    expect(isRenderableIconBytes(pastCeiling)).toBe(false);
    expect(FAVICON_MAX_DECODE_PIXELS).toBe(2048 * 2048);
    // A signature with no IHDR after it can't be sized.
    expect(isRenderableIconBytes(PNG.subarray(0, 12))).toBe(false);
  });

  it('still refuses a page and an empty body', () => {
    expect(isRenderableIconBytes(utf8('<!DOCTYPE html><html><body>Not found</body></html>'))).toBe(
      false,
    );
    expect(isRenderableIconBytes(new Uint8Array(0))).toBe(false);
  });
});

// The size half alone, which a store runs over icons it already holds: raster only, so
// an SVG or bytes no sniff knows are never "oversized", and a raster header that can't be
// read is.
describe('isOversizedRasterIcon', () => {
  it('is true only for a raster icon past the ceiling or with an unreadable header', () => {
    expect(isOversizedRasterIcon(HUGE_PNG)).toBe(true);
    expect(isOversizedRasterIcon(PNG.subarray(0, 12))).toBe(true);
    expect(isOversizedRasterIcon(PNG)).toBe(false);
    expect(
      isOversizedRasterIcon(new TextEncoder().encode('<svg width="99999" height="99999"></svg>')),
    ).toBe(false);
    expect(isOversizedRasterIcon(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
