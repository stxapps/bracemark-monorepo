// The header read that stands between a stranger's bytes and a native decoder.
// What matters: every format `sniffImageMime` lets through is sized from real encoder
// output (ImageMagick and cwebp wrote these fixtures, 300 × 200 each), a header that
// is only partly there is "not yet", never a guess, and an ICO is sized by the image
// it actually holds, not by its directory's claim.

import { IMAGE_MAX_DECODE_PIXELS, imageHeaderSize, isImageDecodable } from './header-size';
import { sniffImageMime } from './sniff';

const b64 = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'base64'));

const FIXTURES: Record<string, Uint8Array> = {
  png: b64(
    'iVBORw0KGgoAAAANSUhEUgAAASwAAADIAQMAAABoEU4WAAAAA1BMVEX/AAAZ4gk3AAAAHklEQVRYw+3BMQEAAADCoPVPbQdvoAAAAAAAAADgNx54AAEXKN2ZAAAAAElFTkSuQmCC',
  ),
  gif: b64('R0lGODlhLAHIAPAAAP8AAAAAACH5BAAAAAAALAAAAAAsAcgAAAL/hI+py+0Po5y02ouz3rz7D4bi'),
  jpeg: b64(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCADIASwDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAUG/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AigJbeAAAAAAAAAAAAP/Z',
  ),
  bmp: b64('Qk2qvwIAAAAAAIoAAAB8AAAALAEAAMgAAAABABgAAAAAACC/AgAAAA=='),
  bmp3: b64('Qk1WvwIAAAAAADYAAAAoAAAALAEAAMgAAAABABgAAAAAACC/AgAAAA=='),
  webpLossy: b64(
    'UklGRtwAAABXRUJQVlA4INAAAAAwEQCdASosAcgAPtFosVMoJiSioCgBABoJaW7hdrEQnAAAE9gHvtk5D32ydM9S',
  ),
  webpLossless: b64('UklGRiQAAABXRUJQVlA4TBcAAAAvK8ExAAcQ/Y/+BwAU6f9/iuh/6v/XAAA='),
  webpExtended: b64(
    'UklGRggBAABXRUJQVlA4WAoAAAAQAAAAKwEAxwAAQUxQSBIAAAABB1DAiAgAKNL//xTR/9T/rwFWUDgg0AAAADAR',
  ),
};

describe('imageHeaderSize', () => {
  it.each(Object.entries(FIXTURES))('sizes a real %s', (_, bytes) => {
    // Only what the sniff takes reaches this, so each fixture is one it takes.
    expect(sniffImageMime(bytes)).toBeDefined();
    expect(imageHeaderSize(bytes)).toEqual({ width: 300, height: 200 });
  });

  it('walks a JPEG’s metadata to the frame header, however long it runs', () => {
    // A 60 KB comment before the frame — the shape EXIF, ICC and XMP give a photo.
    const filler = 60_000;
    const comment = new Uint8Array(4 + filler).fill(0x78);
    comment.set([0xff, 0xfe, ((filler + 2) >> 8) & 0xff, (filler + 2) & 0xff]);
    const jpeg = new Uint8Array([
      ...FIXTURES.jpeg.subarray(0, 2),
      ...comment,
      ...FIXTURES.jpeg.subarray(2),
    ]);

    expect(imageHeaderSize(jpeg)).toEqual({ width: 300, height: 200 });
    // The head of the download alone stops before the frame: not yet, not a guess.
    expect(imageHeaderSize(jpeg.subarray(0, 32 * 1024))).toBeUndefined();
  });

  // Every format but GIF, whose size is in its first ten bytes — less than the sniff
  // itself needs.
  it('is undefined for a header cut short, in every format that can be', () => {
    for (const [format, bytes] of Object.entries(FIXTURES)) {
      if (format === 'gif') continue;
      expect(imageHeaderSize(bytes.subarray(0, 20))).toBeUndefined();
    }
  });

  it('refuses a zero side, and a JPEG whose scan comes before any frame', () => {
    const png = Uint8Array.from(FIXTURES.png);
    png.set([0, 0, 0, 0], 16);
    expect(imageHeaderSize(png)).toBeUndefined();

    const scanFirst = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6, 0xff, 0xd9]);
    expect(imageHeaderSize(scanFirst)).toBeUndefined();
  });

  // The directory can only say "256"; the PNG inside says what a decoder will allocate.
  it('sizes an ICO by the image it holds, not its directory', () => {
    const inner = Uint8Array.from(FIXTURES.png);
    inner.set([0, 0, 0x4e, 0x20, 0, 0, 0x4e, 0x20], 16); // 20000 × 20000
    const directory = new Uint8Array(6 + 16);
    directory.set([0, 0, 1, 0, 1, 0]);
    // width 0, height 0 (= 256), …, then the image's length and offset.
    directory.set([0, 0, 0, 0, 1, 0, 32, 0], 6);
    new DataView(directory.buffer).setUint32(6 + 8, inner.length, true);
    new DataView(directory.buffer).setUint32(6 + 12, directory.length, true);
    const ico = new Uint8Array([...directory, ...inner]);

    expect(sniffImageMime(ico)).toBe('image/x-icon');
    expect(imageHeaderSize(ico)).toEqual({ width: 20000, height: 20000 });
  });

  it('sizes an ICO holding a bitmap, whose height counts its mask twice', () => {
    // ImageMagick's 16 × 16 icon: a BITMAPINFOHEADER of 16 × 32.
    const ico = b64(
      'AAABAAEAEBACAAEAAQCwAAAAFgAAACgAAAAQAAAAIAAAAAEAAQAAAAAAQAAAAAAAAAAAAAAAAgAAAAIAAAAAAP8A',
    );
    expect(imageHeaderSize(ico)).toEqual({ width: 16, height: 16 });
  });

  it('is undefined for anything the sniff refuses', () => {
    expect(imageHeaderSize(new TextEncoder().encode('<!doctype html><html>…</html>'))).toBe(
      undefined,
    );
  });
});

describe('isImageDecodable', () => {
  it('takes a sized image up to the ceiling, and nothing past it or unsized', () => {
    expect(isImageDecodable({ width: 8192, height: 4096 })).toBe(true);
    expect(isImageDecodable({ width: IMAGE_MAX_DECODE_PIXELS, height: 1 })).toBe(true);
    expect(isImageDecodable({ width: IMAGE_MAX_DECODE_PIXELS + 1, height: 1 })).toBe(false);
    expect(isImageDecodable({ width: 20000, height: 20000 })).toBe(false);
    expect(isImageDecodable(undefined)).toBe(false);
  });
});
