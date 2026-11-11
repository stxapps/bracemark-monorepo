import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { newId } from '@stxapps/expo-crypto/lib/ids';
import {
  httpsUpgradeOf,
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

// One image's response — `https://` first for a plain-HTTP address, then the address
// itself: this app's release builds cannot make a plain-HTTP request (Android forbids
// cleartext, iOS's App Transport Security refuses it), and most image hosts answer both.
// docs/link-extraction.md, _plain-HTTP links on a phone_. Undefined when neither gave an
// ok response; the figure is then a placeholder, like any image that can't be had.
async function fetchHttpsFirst(url: string, signal: AbortSignal): Promise<Response | undefined> {
  for (const candidate of [httpsUpgradeOf(url), url]) {
    if (!candidate || signal.aborted) continue;
    try {
      const res = await fetch(candidate, { headers: { 'User-Agent': USER_AGENT }, signal });
      if (res.ok) return res;
    } catch {
      // Refused or unreachable — the next candidate, if there is one.
    }
  }
  return undefined;
}

async function encodeOne(
  source: ReaderImageSource,
  signal: AbortSignal,
): Promise<ReaderImageEntry | undefined> {
  let temp: File | undefined;
  let saved: File | undefined;
  try {
    const res = await fetchHttpsFirst(source.url, signal);
    if (!res) return undefined;
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

// An image the PAGE fetched and encoded for us — the capture screen's WebView runs
// web-react's encoder in the page and posts the result (web-react lib/webview-capture.ts)
// — taken only if it is what that encoder writes: a JPEG, no longer than the pack's
// dimension cap on either side, and not an icon. The bytes came from a stranger's page,
// whose scripts can post anything, so their size is MEASURED here rather than taken from
// the message, and anything else is refused (and fetched natively instead, below).
export async function readerImageFromPage(
  key: string,
  bytes: Uint8Array,
): Promise<ReaderImageEntry | undefined> {
  if (bytes.byteLength === 0 || bytes.byteLength > READER_IMAGE_MAX_SOURCE_BYTES) return undefined;
  if (sniffImageMime(bytes) !== 'image/jpeg') return undefined;
  let temp: File | undefined;
  try {
    temp = newScratchFile(`reader-image-${newId()}`);
    temp.write(bytes);
    const size = await probeImageSize(temp.uri);
    if (!size || isReaderImageTooSmall(size.width, size.height)) return undefined;
    if (Math.max(size.width, size.height) > READER_IMAGE_MAX_DIMENSION) return undefined;
    return { key, type: 'image/jpeg', width: size.width, height: size.height, bytes };
  } catch {
    return undefined;
  } finally {
    deleteQuietly(temp);
  }
}

// The capture screen's collector: what the page posted where it is acceptable, and a
// native fetch for every other address — so each image gets whichever of the two
// reaches it. The page's fetch carries the site's session (an image behind its sign-in);
// the native one has no CORS (an image host that refuses the page a cross-origin read).
// The result is in page order and cut to the pack's budget like any other collection.
export async function collectReaderImagesPreferring(
  sources: readonly ReaderImageSource[],
  fromPage: ReadonlyMap<string, Uint8Array>,
  options: CollectReaderImagesOptions = {},
): Promise<ReaderImageEntry[]> {
  const wanted = sources.slice(0, READER_IMAGES_MAX_COUNT);
  const kept = new Map<string, ReaderImageEntry>();
  for (const source of wanted) {
    const bytes = fromPage.get(source.key);
    if (!bytes) continue;
    const entry = await readerImageFromPage(source.key, bytes);
    if (entry) kept.set(source.key, entry);
  }
  const missing = wanted.filter((source) => !kept.has(source.key));
  if (missing.length > 0) {
    for (const entry of await collectReaderImages(missing, options)) kept.set(entry.key, entry);
  }
  return withinReaderImageBudget(
    wanted
      .map((source) => kept.get(source.key))
      .filter((entry): entry is ReaderImageEntry => entry !== undefined),
  );
}
