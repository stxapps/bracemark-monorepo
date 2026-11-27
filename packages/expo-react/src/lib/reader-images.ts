import { fetch as expoFetch } from 'expo/fetch';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { newId } from '@stxapps/expo-crypto/lib/ids';
import {
  httpsUpgradeOf,
  imageHeaderSize,
  isImageDecodable,
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
// What differs is the platform. The fetch is NATIVE (`expo/fetch`, which streams) — no CORS, so the host that
// refuses a browser's cross-origin read answers here — but it is this app's request,
// not the page's: it is sent with `credentials: 'omit'`, so it carries no cookie of the
// site's (a native fetch is credentialed by default, and the capture WebView shares
// its cookies with the native side), and an image behind the page's sign-in is a
// placeholder. And the decode is the native one, through a file: the body is streamed
// STRAIGHT TO a scratch file → `probeImageSize` → expo-image-manipulator, which hands
// back a JPEG on disk that is read once into the pack. Only the encoded result — what
// the pack holds — is ever whole in JS; the source, up to 8 MB, never is.
//
// Two rules about the DECODE, each silent if dropped (docs/link-extraction-keep.md,
// _images in read mode_, _the decode's memory_):
//
//   - SIZED BEFORE IT IS OPENED. Both native decoders here open an image at full
//     resolution — the manipulator's loader takes no target size, and on Android
//     `probeImageSize` is a full Fresco decode — so a 100 KB PNG that claims
//     20000 × 20000 would cost 1.6 GB to make a 1024 px JPEG. Its size is
//     read from the header first (`imageHeaderSize`) and anything past
//     IMAGE_MAX_DECODE_PIXELS, or that can't be sized, is never handed to a decoder.
//   - ONE DECODE AT A TIME. Fetches run a few at a time, as the web collector's do, but
//     their decodes queue behind each other: three full-resolution photos decoding at
//     once is three times the native peak, for a step that takes milliseconds beside
//     the network's seconds. A decode still queued when the deadline passes is skipped.
//
// Why not decode smaller instead — expo-image's `Image.loadAsync` takes a max size and
// downsamples AS it decodes. Because it caches what it decoded: iOS stores it in
// SDWebImage's DISK cache (its loader hard-codes the policy) and Android's Glide caches
// a transformed local file to disk too, so every article image would leave a plaintext
// copy that the sign-out sweep doesn't reach (features/links/link-media.tsx in the app
// has the rule). The manipulator's own loader (expo-image-loader) caches nothing.
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

// The first bytes of a download, kept in memory while the whole of it goes to disk: what
// the sniff and the header size are read from. Enough for nearly every image — a JPEG's
// frame header follows its metadata, and EXIF, ICC and XMP together rarely pass 100 KB.
// One that runs longer is read back off the file to be sized (encodeOne).
const HEAD_BYTES = 256 * 1024;

export interface StreamedBody {
  // The first HEAD_BYTES of the body, or all of it if shorter.
  head: Uint8Array;
  // The whole body's length, as written to the file.
  size: number;
}

// The response's body, written to `file` (which this creates or replaces), or undefined
// when it is past `limit`. The ceiling is checked BEFORE anything is kept: from
// `content-length` when the host sends one, and otherwise by reading the stream chunk by
// chunk and cancelling it the moment it passes. That needs a response with a stream, which
// React Native's own `fetch` (whatwg-fetch) never has — its `Response` has no `body`, so the
// whole body would be buffered — and `expo/fetch`'s does: this file fetches with the latter,
// as sync/r2.ts does. The buffered branch below is only a fallback for a response without a
// stream (it still enforces the ceiling, after the fact). A page names these addresses, so a
// body that never ends must cost a cancelled request, not the phone's memory or its disk.
//
// Each chunk goes to the file as it arrives (a FileHandle), so the body is never whole in
// JS: only its head is kept. A refused body leaves a partial file, which the caller deletes
// with the rest of its scratch.
export async function streamBodyTo(
  res: Pick<Response, 'headers' | 'body' | 'arrayBuffer'>,
  limit: number,
  file: File,
): Promise<StreamedBody | undefined> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return undefined;
  const reader = res.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > limit) return undefined;
    file.write(bytes);
    return { head: bytes.subarray(0, HEAD_BYTES), size: bytes.byteLength };
  }
  // Created first: iOS opens a handle only on a file that exists.
  file.create({ overwrite: true });
  const handle = file.open();
  const headParts: Uint8Array[] = [];
  let headLength = 0;
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return undefined;
      }
      if (headLength < HEAD_BYTES) {
        const part = value.subarray(0, HEAD_BYTES - headLength);
        // A copy: the stream may reuse its chunk's buffer.
        headParts.push(part.slice());
        headLength += part.byteLength;
      }
      handle.writeBytes(value);
    }
  } finally {
    handle.close();
  }
  const head = new Uint8Array(headLength);
  let at = 0;
  for (const part of headParts) {
    head.set(part, at);
    at += part.byteLength;
  }
  return { head, size };
}

// One image's response — `https://` first for a plain-HTTP address, then the address
// itself: this app's release builds cannot make a plain-HTTP request (Android forbids
// cleartext, iOS's App Transport Security refuses it), and most image hosts answer both.
// docs/link-extraction.md, _plain-HTTP links on a phone_. Undefined when neither gave an
// ok response; the figure is then a placeholder, like any image that can't be had.
async function fetchHttpsFirst(
  url: string,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof expoFetch>> | undefined> {
  for (const candidate of [httpsUpgradeOf(url), url]) {
    if (!candidate || signal.aborted) continue;
    try {
      const res = await expoFetch(candidate, {
        headers: { 'User-Agent': USER_AGENT },
        // No cookie of the site's: this is the app's request, not the page's (the capture
        // WebView shares its cookies with the native side).
        credentials: 'omit',
        signal,
      });
      if (res.ok) return res;
    } catch {
      // Refused or unreachable — the next candidate, if there is one.
    }
  }
  return undefined;
}

// Run tasks one after another, in the order they were queued — the decode queue (header).
type Serial = <T>(task: () => Promise<T>) => Promise<T>;

function serial(): Serial {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>) => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

async function encodeOne(
  source: ReaderImageSource,
  signal: AbortSignal,
  decodeQueue: Serial,
): Promise<ReaderImageEntry | undefined> {
  let temp: File | undefined;
  let saved: File | undefined;
  try {
    const res = await fetchHttpsFirst(source.url, signal);
    if (!res) return undefined;
    const file = newScratchFile(`reader-image-${newId()}`);
    temp = file;
    const body = await streamBodyTo(res, READER_IMAGE_MAX_SOURCE_BYTES, file);
    if (!body || body.size === 0) return undefined;
    // Raster only: an SVG is markup, and an HTML error page is not a picture.
    const sourceType = sniffImageMime(body.head);
    if (sourceType === undefined) return undefined;
    // Sized from the header before any decoder opens it (header). A frame header past the
    // head is read off the file — the source in JS once, at most 8 MB: for an image with
    // that much metadata in front of it, and for EVERY GIF larger than the head, since a GIF
    // is sized by walking each frame to its trailer (shared image/header-size.ts).
    const header =
      imageHeaderSize(body.head) ??
      (body.size > body.head.byteLength ? imageHeaderSize(await file.bytes()) : undefined);
    if (!isImageDecodable(header)) return undefined;

    return await decodeQueue(async () => {
      if (signal.aborted) return undefined;
      const size = await probeImageSize(file.uri);
      if (!size || isReaderImageTooSmall(size.width, size.height)) return undefined;

      const scale = Math.min(1, READER_IMAGE_MAX_DIMENSION / Math.max(size.width, size.height));
      const context = ImageManipulator.manipulate(file.uri);
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

      if (scale === 1 && sourceType === 'image/jpeg' && body.size <= encoded.byteLength) {
        return {
          key: source.key,
          type: sourceType,
          width: size.width,
          height: size.height,
          bytes: await file.bytes(),
        };
      }
      return {
        key: source.key,
        type: 'image/jpeg',
        width: result.width,
        height: result.height,
        bytes: encoded,
      };
    });
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

  const decodeQueue = serial();

  const worker = async () => {
    while (!controller.signal.aborted && total < READER_IMAGES_MAX_BYTES) {
      const index = next++;
      const source = wanted[index];
      if (!source) return;
      const entry = await encodeOne(source, controller.signal, decodeQueue);
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
// the message, and anything else is refused (and fetched natively instead, below). Its
// header is read first, so a decoder only ever opens a JPEG that says it is within the
// dimension cap — a few hundred KB of pixels — and the decoder's answer is the one kept.
export async function readerImageFromPage(
  key: string,
  bytes: Uint8Array,
): Promise<ReaderImageEntry | undefined> {
  if (bytes.byteLength === 0 || bytes.byteLength > READER_IMAGE_MAX_SOURCE_BYTES) return undefined;
  if (sniffImageMime(bytes) !== 'image/jpeg') return undefined;
  const header = imageHeaderSize(bytes);
  if (!header || Math.max(header.width, header.height) > READER_IMAGE_MAX_DIMENSION) {
    return undefined;
  }
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
