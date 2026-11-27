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
  // Whole, to its trailer: a GIF is sized by walking every frame (header-size.ts).
  gif: b64(
    'R0lGODdhLAHIAIAAAP8AAAAAACH5BAkAAAEALAAAAAAsAcgAAAL/hI+py+0Po5y02ouz3rz7D4biSJbmiabqyrbu' +
      'C8fyTNf2jef6zvf+DwwKh8Si8YhMKpfMpvMJjUqn1Kr1is1qt9yu9wsOi8fksvmMTqvX7Lb7DY/L5/S6/Y7P6/f8' +
      'vv8PGCg4SFhoeIiYqLjI2Oj4CBkpOUlZaXmJmam5ydnp+QkaKjpKWmp6ipqqusra6voKGys7S1tre4ubq7vL2+v7' +
      'CxwsPExcbHyMnKy8zNzs/AwdLT1NXW19jZ2tvc3d7f0NHi4+Tl5ufo6err7O3u7+Dh8vP09fb3+Pn6+/z9/v/w8w' +
      'oMCBBAsaPIgwocKFDBs6fAgxosSJFCtavIgxo8aNTRw7evwIMqTIkSRLmjyJMqXKlSxbunwJM6bMmTRr2ryJM6fO' +
      'nTx7+vwJNKjQoUSLGj2KNKnSpUybOn0KNarUqVSrWr2KNavWrVy7/iwAADs=',
  ),
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

  it('is undefined for a header cut short, in every format', () => {
    for (const bytes of Object.values(FIXTURES)) {
      expect(imageHeaderSize(bytes.subarray(0, 20))).toBeUndefined();
    }
    // A GIF cut anywhere before its trailer: a later frame could be larger.
    expect(imageHeaderSize(FIXTURES.gif.subarray(0, FIXTURES.gif.length - 1))).toBeUndefined();
  });

  // A GIF's logical screen is not its decode size: Skia grows its canvas to the first
  // frame, Glide sizes a buffer by each one (header-size.ts, gifSize).
  it('sizes a GIF by the largest of its screen and every frame', () => {
    const gif = (screen: [number, number], frames: [number, number, number, number][]) => {
      const u16 = (n: number) => [n & 0xff, n >> 8];
      const bytes = [
        0x47,
        0x49,
        0x46,
        0x38,
        0x39,
        0x61,
        ...u16(screen[0]),
        ...u16(screen[1]),
        0,
        0,
        0,
      ];
      // A graphic control extension, which a walk must step over.
      bytes.push(0x21, 0xf9, 4, 0, 0, 0, 0, 0);
      for (const [left, top, width, height] of frames) {
        // The descriptor, a 2-colour local table, the code size, one data sub-block.
        bytes.push(0x2c, ...u16(left), ...u16(top), ...u16(width), ...u16(height), 0x80);
        bytes.push(0, 0, 0, 255, 255, 255, 2, 2, 0x44, 0x01, 0);
      }
      bytes.push(0x3b);
      return Uint8Array.from(bytes);
    };
    expect(imageHeaderSize(gif([300, 200], [[0, 0, 300, 200]]))).toEqual({
      width: 300,
      height: 200,
    });
    // A 1 × 1 screen hiding a 20000 × 20000 frame: refused, where the screen alone passed.
    const hidden = gif([1, 1], [[0, 0, 20000, 20000]]);
    expect(imageHeaderSize(hidden)).toEqual({ width: 20000, height: 20000 });
    expect(isImageDecodable(imageHeaderSize(hidden))).toBe(false);
    // A byte that starts no GIF block is malformed, not the end: read as a trailer, it
    // would hide the frame after it.
    const stray = gif([1, 1], [[0, 0, 20000, 20000]]);
    const strayFirst = Uint8Array.from([...stray.subarray(0, 21), 0x00, ...stray.subarray(21)]);
    expect(stray[21]).toBe(0x2c); // the descriptor, after the header and the extension
    expect(imageHeaderSize(strayFirst)).toBeUndefined();
    // The largest extent of any frame, offsets included, and not only the first's.
    expect(
      imageHeaderSize(
        gif(
          [10, 10],
          [
            [0, 0, 5, 5],
            [65535, 0, 65535, 3],
          ],
        ),
      ),
    ).toEqual({
      width: 131070,
      height: 10,
    });
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

  // A decoder may pick any entry; the guard measures the largest, wherever it sits.
  it('sizes an ICO by its largest image, not its first', () => {
    const small = Uint8Array.from(FIXTURES.png); // 300 × 200
    const large = Uint8Array.from(FIXTURES.png);
    large.set([0, 0, 0x4e, 0x20, 0, 0, 0x4e, 0x20], 16); // 20000 × 20000
    const directory = new Uint8Array(6 + 32);
    directory.set([0, 0, 1, 0, 2, 0]);
    const view = new DataView(directory.buffer);
    view.setUint32(6 + 8, small.length, true);
    view.setUint32(6 + 12, directory.length, true);
    view.setUint32(22 + 8, large.length, true);
    view.setUint32(22 + 12, directory.length + small.length, true);
    const ico = new Uint8Array([...directory, ...small, ...large]);
    expect(imageHeaderSize(ico)).toEqual({ width: 20000, height: 20000 });
  });

  // DHT (C4), JPG (C8) and DAC (CC) share the frame markers' range and carry no frame:
  // read as one, a table's bytes would size the image.
  it('does not take a Huffman table for a frame header', () => {
    const dht = [0xff, 0xc4, 0, 7, 0x00, 0x00, 0x01, 0x00, 0x01];
    const jpeg = new Uint8Array([
      ...FIXTURES.jpeg.subarray(0, 2),
      ...dht,
      ...FIXTURES.jpeg.subarray(2),
    ]);
    expect(imageHeaderSize(jpeg)).toEqual({ width: 300, height: 200 });
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
    // The ceiling's value, not only its name: 32 Mi pixels.
    expect(isImageDecodable({ width: 8192, height: 4097 })).toBe(false);
    expect(isImageDecodable({ width: IMAGE_MAX_DECODE_PIXELS, height: 1 })).toBe(true);
    expect(isImageDecodable({ width: IMAGE_MAX_DECODE_PIXELS + 1, height: 1 })).toBe(false);
    expect(isImageDecodable({ width: 20000, height: 20000 })).toBe(false);
    expect(isImageDecodable(undefined)).toBe(false);
  });
});
