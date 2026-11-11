import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { newId } from '@stxapps/expo-crypto/lib/ids';
import {
  isReaderImageTooSmall,
  READER_IMAGE_JPEG_QUALITY,
  READER_IMAGE_MAX_DIMENSION,
  READER_IMAGE_MAX_SOURCE_BYTES,
  READER_IMAGES_MAX_BYTES,
  READER_IMAGES_MAX_COUNT,
  type ReaderImageEntry,
  type ReaderImageSource,
  sniffImageMime,
  withinReaderImageBudget,
} from '@stxapps/shared';

import { newScratchFile, warnIfNotSwept } from '../data/cache-files';
import { probeImageSize } from './image';
import { USER_AGENT } from './user-agent';

// Fetch and encode the images of ONE article on this device — the expo twin of
// web-react's `lib/reader-images.ts` + `lib/reader-image.ts`, whose headers carry the
// rules: a few at a time in page order, one deadline for the whole article, an image
// that can't be had is simply absent, never a throw, the result cut to the pack's
// budget. docs/link-extraction-keep.md, _images in read mode_.
//
// What differs is the platform. The fetch is NATIVE — no CORS, so the host that
// refuses a browser's cross-origin read answers here — but it is this app's request,
// not the page's: it carries no cookie of the site's, so an image behind the page's
// sign-in is a placeholder. And the decode is the native one, through a file: bytes →
// a scratch file → `probeImageSize` → expo-image-manipulator, which hands back a JPEG
// on disk that is read once into the pack.
//
// Every image is re-encoded, for the reason the web encoder gives, unless it is a
// JPEG already within the cap that the re-encode did not make smaller.
export interface CollectReaderImagesOptions {
  deadlineMs?: number;
  concurrency?: number;
}

const DEFAULT_DEADLINE_MS = 30_000;
const DEFAULT_CONCURRENCY = 3;

function deleteQuietly(file: File | undefined): void {
  try {
    if (file?.exists) file.delete();
  } catch {
    // A leftover is the sign-out sweep's (cache-files.ts).
  }
}

async function encodeOne(
  source: ReaderImageSource,
  signal: AbortSignal,
): Promise<ReaderImageEntry | undefined> {
  let temp: File | undefined;
  let saved: File | undefined;
  try {
    const res = await fetch(source.url, { headers: { 'User-Agent': USER_AGENT }, signal });
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > READER_IMAGE_MAX_SOURCE_BYTES) {
      return undefined;
    }
    // Raster only: an SVG is markup, and an HTML error page is not a picture.
    const sourceType = sniffImageMime(bytes);
    if (sourceType === undefined) return undefined;

    temp = newScratchFile(`reader-image-${newId()}`);
    temp.write(bytes);
    const size = await probeImageSize(temp.uri);
    if (!size || isReaderImageTooSmall(size.width, size.height)) return undefined;

    const scale = Math.min(1, READER_IMAGE_MAX_DIMENSION / Math.max(size.width, size.height));
    const context = ImageManipulator.manipulate(temp.uri);
    if (scale < 1) {
      context.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      });
    }
    const rendered = await context.renderAsync();
    const result = await rendered.saveAsync({
      compress: READER_IMAGE_JPEG_QUALITY,
      format: SaveFormat.JPEG,
    });
    warnIfNotSwept(result.uri, 'expo-image-manipulator');
    saved = new File(result.uri);
    const encoded = await saved.bytes();

    if (scale === 1 && sourceType === 'image/jpeg' && bytes.byteLength <= encoded.byteLength) {
      return {
        key: source.key,
        type: sourceType,
        width: size.width,
        height: size.height,
        bytes,
      };
    }
    return {
      key: source.key,
      type: 'image/jpeg',
      width: result.width,
      height: result.height,
      bytes: encoded,
    };
  } catch {
    return undefined;
  } finally {
    deleteQuietly(temp);
    deleteQuietly(saved);
  }
}

export async function collectReaderImages(
  sources: readonly ReaderImageSource[],
  options: CollectReaderImagesOptions = {},
): Promise<ReaderImageEntry[]> {
  const { deadlineMs = DEFAULT_DEADLINE_MS, concurrency = DEFAULT_CONCURRENCY } = options;
  const wanted = sources.slice(0, READER_IMAGES_MAX_COUNT);
  if (wanted.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const found: (ReaderImageEntry | undefined)[] = new Array(wanted.length);
  let next = 0;
  let total = 0;

  const worker = async () => {
    while (!controller.signal.aborted && total < READER_IMAGES_MAX_BYTES) {
      const index = next++;
      const source = wanted[index];
      if (!source) return;
      const entry = await encodeOne(source, controller.signal);
      if (!entry) continue;
      found[index] = entry;
      total += entry.bytes.length;
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
  } finally {
    clearTimeout(timer);
  }
  return withinReaderImageBudget(found.filter((entry) => entry !== undefined));
}
