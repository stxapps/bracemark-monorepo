// One article image, made ready to keep in a read-mode copy's image pack — the web
// half (bracemark-web's server path and the browser extension's service worker; the
// expo twin is expo-react `lib/reader-image.ts`). docs/link-extraction-keep.md,
// _images in read mode_.
//
// It is NOT `resizeImage` with other numbers, though it is built on the same two
// worker-native APIs (`createImageBitmap` + `OffscreenCanvas`, for the reason
// resize-image.ts gives). Three differences, each from what a pack is:
//
//   - it REFUSES where resizeImage passes through. A preview that won't decode is
//     stored as it came, because one slightly large blob is the worst case; here the
//     worst case is an HTML error page or an SVG packed as a picture, so anything that
//     is not a raster image this runtime can decode is not kept at all;
//   - it reports the stored SIZE in pixels, which the figure block carries so the
//     reader can hold the space before the pack has loaded;
//   - it re-encodes even an image already within the cap, unless that image is a JPEG
//     and smaller as it stands. A preview within 1024 px is stored unchanged; an
//     article is thirty images against one byte budget, and a 900 px PNG screenshot or
//     an animated GIF is megabytes as it stands.
//
// Flattened onto white: JPEG has no alpha, and a transparent diagram on the canvas's
// default black is unreadable.

// Zod-free subpaths, not the barrel: this file is bundled into the script expo's capture
// screen injects into a page (web-react lib/webview-capture.ts), where the barrel would
// carry zod and every schema with it — reader-doc-from-page.ts says the same.
import { sniffImageMime } from '@stxapps/shared/image/sniff';
import {
  isReaderImageTooSmall,
  READER_IMAGE_JPEG_QUALITY,
  READER_IMAGE_MAX_DIMENSION,
} from '@stxapps/shared/reader/reader-doc-core';

export interface ReaderImageOptions {
  maxDimension?: number;
  quality?: number;
}

export interface EncodedReaderImage {
  bytes: Uint8Array;
  type: string;
  width: number;
  height: number;
}

// Why an image was not kept — for the capture's own bookkeeping and the measurement;
// every one of them leaves the figure a placeholder.
export type ReaderImageRefusal = 'not-an-image' | 'undecodable' | 'too-small';

export async function encodeReaderImage(
  source: Uint8Array,
  options: ReaderImageOptions = {},
): Promise<EncodedReaderImage | ReaderImageRefusal> {
  const { maxDimension = READER_IMAGE_MAX_DIMENSION, quality = READER_IMAGE_JPEG_QUALITY } =
    options;

  const sourceType = sniffImageMime(source);
  if (sourceType === undefined) return 'not-an-image';
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return 'undecodable';
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([source as BlobPart]), {
      imageOrientation: 'from-image',
    });
  } catch {
    return 'undecodable';
  }

  try {
    if (isReaderImageTooSmall(bitmap.width, bitmap.height)) return 'too-small';

    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = Math.min(1, maxDimension / longest);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'undecodable';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    const encoded = new Uint8Array(
      await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer(),
    );

    // A JPEG already within the cap that the re-encode did not make smaller is kept
    // as it came: recompressing it would cost quality and bytes both.
    if (scale === 1 && sourceType === 'image/jpeg' && source.length <= encoded.length) {
      return { bytes: source, type: sourceType, width, height };
    }
    return { bytes: encoded, type: 'image/jpeg', width, height };
  } catch {
    return 'undecodable';
  } finally {
    bitmap.close();
  }
}
