// The device's IMAGE PRIMITIVES — the things every path that puts an image into
// the store needs before it can: cap it (`resizeImage`) and learn its dimensions
// (`probeImageSize`, the input `resizeImage` demands). They sit together because
// they're the same LAYER, not the same feature: each is a thin wrapper over a
// NATIVE DECODER, each is uri-shaped rather than store-shaped, and each NEVER
// THROWS — every one degrades to "keep what we had", so an image can only ever
// end up bigger or absent, never lost to a hiccup.
//
// The third thing these paths need — "are these bytes a renderable image at
// all" (`sniffImageMime`, `isSvgBytes`) — used to live here too. It moved to
// `@stxapps/shared` (`image/sniff.ts`) once web's favicon path needed the same
// verdict: those two are pure byte shapes with no decoder behind them, so
// nothing tied them to this platform, and one definition is what keeps the two
// platforms from drifting on what counts as an icon.
//
// The web sibling is `packages/web-react/src/lib/resize-image.ts`, which is
// resize ONLY: there `createImageBitmap` sniffs the format itself and reports
// the dimensions off the decoded bitmap, so neither of the other two exists.
// That header stays canonical for the RESIZE contract — the deferred CLIENT
// thumbnailing step; the extractor server never resizes, so bounding what lands
// in `files/{id}.enc` is the client's job, and it bounds the per-user byte
// quota.
//
// Callers: the edit screen's custom-image pick and `saveCustomImage`
// (hooks/use-link-mutations.ts), and the on-device extraction worker
// (lib/device-extraction.ts).

import { Image } from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { PREVIEW_JPEG_QUALITY, PREVIEW_MAX_DIMENSION } from '@stxapps/shared';

// The cap + quality are `@stxapps/shared`'s (image/preview.ts), shared with the web
// sibling so the same og:image is stored at the same size whichever platform captured it.
// `SaveFormat.JPEG` below is that contract's format, spelled this platform's way.
const DEFAULT_MAX_DIMENSION = PREVIEW_MAX_DIMENSION;
const DEFAULT_QUALITY = PREVIEW_JPEG_QUALITY;

export interface ResizeImageSource {
  uri: string;
  width: number;
  height: number;
}

// Cap an image's dimensions before it's stored. Web's spec, uri-in/uri-out
// instead of bytes-in/bytes-out — file content stays out of the JS heap on this
// platform (file-store.ts), and both the picker upstream and writeFile
// downstream speak file uris:
//
//  - Longest side capped at 1024 (CSS px), both dims scaled together (aspect
//    preserved), re-encoded JPEG at 0.82 — web's exact defaults.
//  - Already within the cap → the ORIGINAL uri returned untouched, no
//    transcode. The caller supplies the source dimensions (the picker reports
//    them; anything downloaded has to `probeImageSize` first), so the
//    pass-through needs no decode.
//  - NEVER throws: any manipulator failure (undecodable input, native hiccup)
//    returns the original uri — a resize hiccup can only cost a larger stored
//    blob, never the image itself.
//
// Returns the (possibly new) uri WITH its dimensions, so a resize can chain:
// the edit screen resizes at pick time and hands the result to
// saveCustomImage's backstop resize — if the first attempt fell back (original
// dims ride along), the backstop genuinely retries; if it succeeded (capped
// dims ride along), the backstop passes through for free.
export async function resizeImage(source: ResizeImageSource): Promise<ResizeImageSource> {
  const { uri, width, height } = source;
  const longest = Math.max(width, height);
  // Within the cap — or dimensions unknown (0/NaN, nothing to scale by): the
  // original passes through, the same keep-the-image-over-the-cap bias as
  // web's undecodable-input fallback.
  if (!(longest > DEFAULT_MAX_DIMENSION)) return source;

  try {
    const scale = DEFAULT_MAX_DIMENSION / longest;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const context = ImageManipulator.manipulate(uri);
    context.resize({ width: targetWidth, height: targetHeight });
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ compress: DEFAULT_QUALITY, format: SaveFormat.JPEG });
    return { uri: saved.uri, width: saved.width, height: saved.height };
  } catch {
    return source;
  }
}

// An image's intrinsic dimensions, or undefined if the native decoder can't
// read it. Promisified `Image.getSize` — RN's only decode-free probe.
//
// This is `resizeImage`'s missing input, not a general utility: `resizeImage`
// takes the source dimensions from its CALLER and passes the image through
// untouched when they're absent, which is right for the picker (it reports
// them) and wrong for anything DOWNLOADED — without a probe a 4000px hero would
// skip the cap entirely and land whole in the user's byte quota. So a caller
// holding fetched bytes rather than a picker asset probes first.
export function probeImageSize(
  uri: string,
): Promise<{ width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    Image.getSize(
      uri,
      (width, height) => resolve(width > 0 && height > 0 ? { width, height } : undefined),
      () => resolve(undefined),
    );
  });
}
