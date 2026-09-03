// Specs for the device's image primitives. Both never throw, and both degrade to "keep
// what we had" — so every failure they absorb is silent by design, and the only way to know
// they still absorb it is to make them absorb it here.
//
// `resizeImage` is the deferred CLIENT thumbnailing step (web's resize-image.ts is the
// canonical header): the extractor never resizes, so bounding what lands in
// `files/{id}.enc` is the client's job, and it is what bounds the per-user byte quota. The
// two things this port can get wrong on its own:
//
//   - THE PASS-THROUGH IDENTITY. An image already within the cap returns the ORIGINAL
//     source untouched — no transcode. Unlike web, this port takes the source dimensions
//     from its CALLER, so "unknown dimensions" (0, NaN) lands in the same branch. That is
//     right for the picker (it reports them) and is exactly why a caller holding
//     DOWNLOADED bytes must `probeImageSize` first — without a probe a 4000px hero skips
//     the cap and lands whole in the user's quota.
//   - THE CHAINABLE RETURN. The result carries its dimensions so a second resize can tell
//     "already capped" from "fell back": the edit screen resizes at pick time and hands the
//     result to saveCustomImage's backstop, which must genuinely retry after a fallback and
//     pass through for free after a success.
//
// The cap and quality are asserted against the SHARED constants, not restated — their whole
// point is that the same og:image is stored at the same size whichever platform captured it.

import { Image } from 'react-native';
import { SaveFormat } from 'expo-image-manipulator';

import { PREVIEW_JPEG_QUALITY, PREVIEW_MAX_DIMENSION } from '@stxapps/shared';

import { probeImageSize, resizeImage } from './image';

// What the manipulator was asked for, recorded by the stub.
const resized: { width: number; height: number }[] = [];
const saved: { compress?: number; format?: unknown }[] = [];
let manipulateFails = false;

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  ImageManipulator: { manipulate: (uri: string) => mockManipulate(uri) },
}));

const mockManipulate = (uri: string) => ({
  resize: (size: { width: number; height: number }) => void resized.push(size),
  renderAsync: async () => {
    if (manipulateFails) throw new Error('native decode failed');
    return {
      saveAsync: async (options: { compress?: number; format?: unknown }) => {
        saved.push(options);
        const last = resized[resized.length - 1];
        return { uri: `${uri}.resized`, width: last.width, height: last.height };
      },
    };
  },
});

beforeEach(() => {
  resized.length = 0;
  saved.length = 0;
  manipulateFails = false;
});

describe('resizeImage', () => {
  // IDENTITY, not equality: the only way to prove nothing was re-encoded on the way past.
  it('returns an image already within the cap untouched, with no transcode', async () => {
    const source = { uri: 'file:///pick.jpg', width: PREVIEW_MAX_DIMENSION, height: 200 };

    expect(await resizeImage(source)).toBe(source);
    expect(resized).toEqual([]);
  });

  // The boundary: exactly at the cap is WITHIN it. One pixel either way decides between a
  // pass-through and a full decode-resize-encode of every such image.
  it('treats an image exactly at the cap as within it', async () => {
    const source = { uri: 'file:///pick.jpg', width: 200, height: PREVIEW_MAX_DIMENSION };

    expect(await resizeImage(source)).toBe(source);
  });

  // THE PLATFORM'S OWN TRAP. Dimensions come from the caller here, so 0/NaN means "nothing
  // to scale by" and the image passes through whole — which is the right bias, and is
  // precisely why anything DOWNLOADED has to probe first rather than trusting this call.
  it.each([
    ['zero', 0],
    ['NaN', NaN],
  ])('passes an image through when its dimensions are %s', async (_label, value) => {
    const source = { uri: 'file:///downloaded', width: value, height: value };

    expect(await resizeImage(source)).toBe(source);
    expect(resized).toEqual([]);
  });

  it('scales an oversized image down to the cap on its longest side', async () => {
    const result = await resizeImage({
      uri: 'file:///hero.jpg',
      width: PREVIEW_MAX_DIMENSION * 2,
      height: PREVIEW_MAX_DIMENSION,
    });

    expect(resized).toEqual([{ width: PREVIEW_MAX_DIMENSION, height: PREVIEW_MAX_DIMENSION / 2 }]);
    expect(result.uri).toBe('file:///hero.jpg.resized');
    expect(result.width).toBe(PREVIEW_MAX_DIMENSION);
  });

  // The cap is on the LONGEST side, whichever it is — a portrait image capped on its width
  // would come out twice as tall as intended and cost twice the quota.
  it('caps a portrait image on its height', async () => {
    await resizeImage({
      uri: 'file:///tall.jpg',
      width: PREVIEW_MAX_DIMENSION,
      height: PREVIEW_MAX_DIMENSION * 4,
    });

    expect(resized).toEqual([{ width: PREVIEW_MAX_DIMENSION / 4, height: PREVIEW_MAX_DIMENSION }]);
  });

  // A 1×20000 banner scales to a zero-width target without the floor, which the manipulator
  // has no sensible answer for.
  it('never scales a dimension below one pixel', async () => {
    await resizeImage({ uri: 'file:///banner.jpg', width: 1, height: PREVIEW_MAX_DIMENSION * 50 });

    expect(resized).toEqual([{ width: 1, height: PREVIEW_MAX_DIMENSION }]);
  });

  // The shared contract, spelled this platform's way: same quality, same format, so a
  // preview stored from a phone and one stored from a browser are the same size against the
  // same byte quota.
  it('encodes at the shared quality and format', async () => {
    await resizeImage({ uri: 'file:///hero.jpg', width: PREVIEW_MAX_DIMENSION * 2, height: 100 });

    expect(saved).toEqual([{ compress: PREVIEW_JPEG_QUALITY, format: SaveFormat.JPEG }]);
  });

  // NEVER THROWS: a native hiccup can only cost a larger stored blob, never the image. The
  // fallback returns the SOURCE, dimensions and all — which is what makes the backstop
  // resize downstream able to genuinely retry.
  it('falls back to the original source when the manipulator fails', async () => {
    manipulateFails = true;
    const source = { uri: 'file:///hero.jpg', width: PREVIEW_MAX_DIMENSION * 2, height: 100 };

    expect(await resizeImage(source)).toBe(source);
  });

  // THE CHAIN. A fallback carries the ORIGINAL (still oversized) dimensions, so a second
  // pass retries; a success carries the capped ones, so a second pass is free.
  it('returns dimensions a second resize can act on', async () => {
    const oversized = { uri: 'file:///hero.jpg', width: PREVIEW_MAX_DIMENSION * 2, height: 100 };

    manipulateFails = true;
    const afterFallback = await resizeImage(oversized);
    manipulateFails = false;
    resized.length = 0;
    await resizeImage(afterFallback);
    expect(resized).toHaveLength(1); // the retry genuinely ran

    resized.length = 0;
    const capped = await resizeImage(oversized);
    await resizeImage(capped);
    expect(resized).toHaveLength(1); // …and the second pass over a capped result did not
  });
});

describe('probeImageSize', () => {
  // `resizeImage`'s missing input for anything downloaded — without it a 4000px hero skips
  // the cap entirely.
  it('reports the intrinsic dimensions', async () => {
    jest
      .spyOn(Image, 'getSize')
      .mockImplementation((_uri: string, ok: (w: number, h: number) => void) => ok(4000, 3000));

    expect(await probeImageSize('file:///hero.jpg')).toEqual({ width: 4000, height: 3000 });
  });

  // Undecodable input answers `undefined`, NOT a throw — the caller then passes the image
  // through uncapped, which is the keep-the-image bias the whole layer is built on.
  it('is undefined when the decoder cannot read the image', async () => {
    jest
      .spyOn(Image, 'getSize')
      .mockImplementation(
        (_uri: string, _ok: (w: number, h: number) => void, fail?: (error: Error) => void) =>
          fail?.(new Error('unsupported')),
      );

    expect(await probeImageSize('file:///broken')).toBeUndefined();
  });

  // A zero dimension is not a usable answer: `resizeImage` would read it as "nothing to
  // scale by" and pass a possibly-huge image through, so it must not be reported as a size.
  it('is undefined for a degenerate zero dimension', async () => {
    jest
      .spyOn(Image, 'getSize')
      .mockImplementation((_uri: string, ok: (w: number, h: number) => void) => ok(0, 3000));

    expect(await probeImageSize('file:///weird')).toBeUndefined();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
});
