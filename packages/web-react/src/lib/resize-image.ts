// Cap a preview image's dimensions and re-encode it before it's stored — the
// deferred CLIENT thumbnailing step the design assigns to the client, never the
// server (docs/link-extraction.md "server extraction": `bracemark-extractor` never
// resizes/transcodes — that would force a full decode and risk the isolate OOMing,
// and it belongs on the client anyway, to bound the per-user storage quota). It runs
// at the byte-producing boundary of EVERY capture source so what lands in
// `files/{id}.enc` is already capped: the bracemark-web server-extraction path
// (`runServerTitleImageBatch`) and — once factored the same way — the extension's
// active-tab capture.
//
// Implemented on `createImageBitmap` + `OffscreenCanvas`, NOT a DOM `<canvas>` /
// `new Image()` library (e.g. blueimp-load-image): those need DOM APIs that don't
// exist in the extension's MV3 service worker, whereas these worker-native APIs run
// in both the SW and the bracemark-web page (and let the work move off the main thread).
// `imageOrientation: 'from-image'` honors EXIF, the one thing such libraries are
// otherwise useful for here.

import { PREVIEW_JPEG_QUALITY, PREVIEW_MAX_DIMENSION } from '@stxapps/shared';

export interface ResizeImageOptions {
  // Cap on the longest side, in CSS pixels. An image already within the cap is
  // returned UNCHANGED (no needless transcode); only oversized images are scaled.
  maxDimension?: number;
  // Output encoding for the re-encoded (scaled) image. JPEG by default: it's
  // universally encodable via `convertToBlob` (Safari included, unlike WebP) and the
  // right tradeoff for photographic preview images; the alpha loss is irrelevant for
  // an og:image thumbnail.
  type?: string;
  // Lossy-encode quality (0..1), for `type`s that honor it.
  quality?: number;
}

// The cap + quality are `@stxapps/shared`'s (image/preview.ts) — the same numbers the
// expo sibling reads, so a preview stored from a phone and one stored from a browser are
// the same size against the same byte quota. Only the FORMAT is spelled locally: this
// decoder wants a MIME string where the manipulator wants a `SaveFormat`.
const DEFAULT_MAX_DIMENSION = PREVIEW_MAX_DIMENSION;
const DEFAULT_TYPE = 'image/jpeg';
const DEFAULT_QUALITY = PREVIEW_JPEG_QUALITY;

// Decode `bytes`, and if its longest side exceeds `maxDimension`, return a
// scaled-down re-encode; otherwise return the original bytes untouched. NEVER throws
// for an undecodable/unsupported input (SVG, a corrupt or non-image blob, or a
// runtime without `createImageBitmap`): it falls back to the original bytes, so a
// resize hiccup can only cost a slightly larger stored blob, never the image itself.
//
// No content-type is needed: `createImageBitmap` determines the format by SNIFFING the
// bytes (the `Blob` type is only a hint it overrides for every raster format), so the
// callers don't track a MIME — the same reason `<img>` renders an object URL built from
// typeless bytes.
export async function resizeImage(
  bytes: Uint8Array,
  options: ResizeImageOptions = {},
): Promise<Uint8Array> {
  const {
    maxDimension = DEFAULT_MAX_DIMENSION,
    type = DEFAULT_TYPE,
    quality = DEFAULT_QUALITY,
  } = options;

  // No worker-native decode available (very old runtime, or SSR import path) — keep
  // the original; the capture is still correct, just uncapped.
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return bytes;
  }

  // `as BlobPart`: a generic `Uint8Array<ArrayBufferLike>` isn't assignable to the
  // lib's `ArrayBufferView<ArrayBuffer>` BlobPart (the SharedArrayBuffer case) — the
  // same cast the extension's Complete.tsx uses to build a Blob from captured bytes.
  const blob = new Blob([bytes as BlobPart]);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // Undecodable (e.g. SVG) — store as-is.
    return bytes;
  }

  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    // Already within the cap: don't transcode, return the original bytes verbatim.
    if (longest <= maxDimension) return bytes;

    const scale = maxDimension / longest;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return bytes;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const out = await canvas.convertToBlob({ type, quality });
    return new Uint8Array(await out.arrayBuffer());
  } catch {
    return bytes;
  } finally {
    bitmap.close();
  }
}
