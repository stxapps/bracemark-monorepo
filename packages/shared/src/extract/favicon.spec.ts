// The icon verdict both platforms' fillers share. Beyond "is it an image", the
// two things this file exists to pin are the ones the platforms disagreed on
// before it was hoisted: the CAP (web had only the extractor's 10 MB proxy
// ceiling, which is not a statement about icons) and the SVG MIME (web renders
// through an `<img>` object URL, which content-sniffs raster but not SVG).

import { sniffImageMime } from '../image/sniff';
import { isRenderableIconBytes, MAX_FAVICON_BYTES, sniffIconMime } from './favicon';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

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

  it('still refuses a page and an empty body', () => {
    expect(isRenderableIconBytes(utf8('<!DOCTYPE html><html><body>Not found</body></html>'))).toBe(
      false,
    );
    expect(isRenderableIconBytes(new Uint8Array(0))).toBe(false);
  });
});
