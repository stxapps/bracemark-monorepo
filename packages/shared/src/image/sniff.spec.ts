// The two byte sniffs. What's worth pinning is the LINE BETWEEN THEM
// (sniff.ts's headers): the icon path takes SVG because both platforms' icon
// renderers decode it, the store path must keep refusing it because expo's
// probeImageSize/resizeImage can't measure or cap it. Plus the one hazard a text
// sniff has that a magic-byte sniff doesn't — an HTML error page carrying an
// inline `<svg>`, which is exactly the response a misconfigured host serves at
// the guessed /favicon.ico path.
//
// Moved here with the code from @stxapps/expo-react's lib/image.spec.ts; the
// wider icon verdict built on these is extract/favicon.spec.ts.

import { isSvgBytes, sniffImageMime } from './sniff';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('isSvgBytes', () => {
  it('takes a bare root tag', () => {
    expect(isSvgBytes(utf8('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))).toBe(true);
  });

  it('takes the self-closing and uppercase spellings', () => {
    expect(isSvgBytes(utf8('<svg/>'))).toBe(true);
    expect(isSvgBytes(utf8('<SVG viewBox="0 0 16 16"></SVG>'))).toBe(true);
  });

  it('takes a full prologue — declaration, comment, doctype, whitespace, BOM', () => {
    expect(
      isSvgBytes(
        utf8(
          '﻿ <?xml version="1.0" encoding="UTF-8"?>\n' +
            '<!-- Generator: some editor\n   (multi-line) -->\n' +
            '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ' +
            '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
            '<svg width="16" height="16"></svg>',
        ),
      ),
    ).toBe(true);
  });

  it('refuses an HTML page that merely CONTAINS an svg', () => {
    expect(
      isSvgBytes(utf8('<!DOCTYPE html><html><body><h1>404</h1><svg><path/></svg></body></html>')),
    ).toBe(false);
    expect(isSvgBytes(utf8('<html><head></head><body><svg/></body></html>'))).toBe(false);
  });

  it('refuses binary and empty input', () => {
    expect(isSvgBytes(PNG)).toBe(false);
    expect(isSvgBytes(new Uint8Array(0))).toBe(false);
  });

  it('only looks at the head — a root tag pushed past it is a miss', () => {
    expect(isSvgBytes(utf8(`<!--${'x'.repeat(2000)}--><svg/>`))).toBe(false);
  });
});

describe('sniffImageMime', () => {
  it('identifies raster formats by magic bytes', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'image/jpeg',
    );
    expect(sniffImageMime(new Uint8Array([0, 0, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(
      'image/x-icon',
    );
  });

  it('keeps refusing SVG — the store path measures and caps what it accepts', () => {
    expect(sniffImageMime(utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeUndefined();
  });
});
