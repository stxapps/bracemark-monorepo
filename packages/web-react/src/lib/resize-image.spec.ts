// Specs for the client thumbnailing step every capture source passes its preview bytes
// through. Two things about this module are easy to get wrong and impossible to see:
//
//   - it MUST NEVER THROW. It sits at the byte-producing boundary of a capture, and its
//     callers treat a thrown error as a failed extraction — so an undecodable input (an
//     SVG og:image, a corrupt blob) or a runtime without the worker-native APIs has to
//     degrade to the ORIGINAL bytes. The cost of that fallback is one larger stored blob;
//     the cost of a throw is a link marked failed for a page that extracted fine.
//   - an image ALREADY within the cap is returned VERBATIM. Transcoding it anyway would
//     re-encode every already-small preview through JPEG — quality lost, alpha lost, and
//     for the many icons/screenshots that are already small, bytes GAINED. That branch
//     returns the input by identity, which is the only way to be sure nothing re-encoded.
//
// The two platform APIs are stubbed, and only those: `createImageBitmap` and
// `OffscreenCanvas` do not exist under node, so without stand-ins every case would take
// the no-decode fallback and the scale arithmetic — the actual content of this module —
// would have no coverage at all. Everything above them (the cap comparison, the aspect
// ratio, the 1px floor, the `close`) is the real code.
//
// The cap and quality are asserted against the SHARED constants (image/preview.ts) rather
// than restated, because their whole point is that a preview stored from a browser and
// one stored from a phone are the same size against the same byte quota — a spec with its
// own copy of the number would let those drift apart silently.

import { PREVIEW_JPEG_QUALITY, PREVIEW_MAX_DIMENSION } from '@stxapps/shared';

import { resizeImage } from './resize-image';

// What the encode was asked for, recorded by the OffscreenCanvas stand-in.
interface Encoded {
  width: number;
  height: number;
  options: { type?: string; quality?: number } | undefined;
}

let encoded: Encoded[];
let closed: number;

// A decoded image of the given size. `close` is counted because the bitmap holds native
// memory: leaking one per extracted link is a slow drift no assertion elsewhere would see.
function stubDecoder(size: { width: number; height: number } | Error): void {
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: jest.fn(async () => {
      if (size instanceof Error) throw size;
      return { ...size, close: () => void (closed += 1) };
    }),
  });
}

class StubOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  getContext(): { drawImage: () => void } | null {
    return { drawImage: () => undefined };
  }

  async convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> {
    encoded.push({ width: this.width, height: this.height, options });
    // Deliberately different bytes from any input, so "returned the original" and
    // "returned the re-encode" can never be confused.
    return new Blob([new Uint8Array([255, 254, 253])]);
  }
}

const ORIGINAL = new Uint8Array([1, 2, 3, 4, 5]);

beforeEach(() => {
  encoded = [];
  closed = 0;
  Object.defineProperty(globalThis, 'OffscreenCanvas', {
    configurable: true,
    value: StubOffscreenCanvas,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: undefined });
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: undefined });
});

describe('resizeImage', () => {
  // The MV3 service worker of an older browser, or the SSR import path: the capture is
  // still correct, just uncapped.
  it('returns the original bytes when there is no worker-native decode', async () => {
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: undefined,
    });

    expect(await resizeImage(ORIGINAL)).toBe(ORIGINAL);
  });

  it('returns the original bytes when there is no OffscreenCanvas', async () => {
    stubDecoder({ width: 4000, height: 4000 });
    Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: undefined });

    expect(await resizeImage(ORIGINAL)).toBe(ORIGINAL);
  });

  // An SVG og:image, or a blob that isn't an image at all. Storing it as-is is right —
  // the renderer may still handle it, and a throw here would fail the whole extraction.
  it('returns the original bytes for something it cannot decode', async () => {
    stubDecoder(new Error('The source image could not be decoded'));

    expect(await resizeImage(ORIGINAL)).toBe(ORIGINAL);
  });

  // IDENTITY, not equality: the only way to prove nothing was re-encoded on the way past.
  it('returns an image already within the cap verbatim, with no transcode', async () => {
    stubDecoder({ width: PREVIEW_MAX_DIMENSION, height: PREVIEW_MAX_DIMENSION - 1 });

    expect(await resizeImage(ORIGINAL)).toBe(ORIGINAL);
    expect(encoded).toEqual([]);
  });

  // The boundary is `<=`: an image exactly at the cap is within it. One pixel either way
  // decides between a verbatim store and a full decode-scale-encode of every such image.
  it('treats an image exactly at the cap as within it', async () => {
    stubDecoder({ width: PREVIEW_MAX_DIMENSION, height: 10 });

    expect(await resizeImage(ORIGINAL)).toBe(ORIGINAL);
  });

  it('scales an oversized image down to the cap on its longest side', async () => {
    stubDecoder({ width: PREVIEW_MAX_DIMENSION * 2, height: PREVIEW_MAX_DIMENSION });

    const out = await resizeImage(ORIGINAL);

    expect(out).not.toBe(ORIGINAL);
    expect(encoded).toEqual([
      {
        width: PREVIEW_MAX_DIMENSION,
        height: PREVIEW_MAX_DIMENSION / 2,
        options: { type: 'image/jpeg', quality: PREVIEW_JPEG_QUALITY },
      },
    ]);
  });

  // The cap is on the LONGEST side, whichever it is — a portrait image capped on its
  // width instead would come out twice as tall as intended.
  it('caps a portrait image on its height', async () => {
    stubDecoder({ width: PREVIEW_MAX_DIMENSION, height: PREVIEW_MAX_DIMENSION * 4 });

    await resizeImage(ORIGINAL);

    expect(encoded[0]).toMatchObject({
      width: PREVIEW_MAX_DIMENSION / 4,
      height: PREVIEW_MAX_DIMENSION,
    });
  });

  // A 1×20000 banner scales to a zero-width canvas without the floor — and
  // `new OffscreenCanvas(0, …)` produces an unusable image rather than an error.
  it('never scales a dimension below one pixel', async () => {
    stubDecoder({ width: 1, height: PREVIEW_MAX_DIMENSION * 50 });

    await resizeImage(ORIGINAL);

    expect(encoded[0]).toMatchObject({ width: 1, height: PREVIEW_MAX_DIMENSION });
  });

  it('honours an explicit cap, type and quality', async () => {
    stubDecoder({ width: 800, height: 400 });

    await resizeImage(ORIGINAL, { maxDimension: 100, type: 'image/png', quality: 0.5 });

    expect(encoded).toEqual([
      { width: 100, height: 50, options: { type: 'image/png', quality: 0.5 } },
    ]);
  });

  // The bitmap holds native memory. It is closed in a `finally`, so it must be released
  // on the scaled path, the within-cap early return, and an encode failure alike.
  it.each([
    ['a scaled image', { width: PREVIEW_MAX_DIMENSION * 2, height: 10 }],
    ['an image within the cap', { width: 10, height: 10 }],
  ])('closes the decoded bitmap for %s', async (_label, size) => {
    stubDecoder(size);

    await resizeImage(ORIGINAL);

    expect(closed).toBe(1);
  });

  it('falls back to the original bytes — and still closes the bitmap — when the encode fails', async () => {
    stubDecoder({ width: PREVIEW_MAX_DIMENSION * 2, height: 10 });
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      configurable: true,
      value: class {
        getContext() {
          return { drawImage: () => undefined };
        }
        convertToBlob(): Promise<Blob> {
          return Promise.reject(new Error('encoder unavailable'));
        }
      },
    });

    expect(await resizeImage(ORIGINAL)).toBe(ORIGINAL);
    expect(closed).toBe(1);
  });

  // A canvas that can't hand back a 2d context (a headless/blocked runtime) is another
  // "keep the original" case, not a failure.
  it('returns the original bytes when no 2d context is available', async () => {
    stubDecoder({ width: PREVIEW_MAX_DIMENSION * 2, height: 10 });
    Object.defineProperty(globalThis, 'OffscreenCanvas', {
      configurable: true,
      value: class {
        getContext() {
          return null;
        }
      },
    });

    expect(await resizeImage(ORIGINAL)).toBe(ORIGINAL);
  });
});
