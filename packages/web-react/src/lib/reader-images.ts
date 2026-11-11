import {
  READER_IMAGE_MAX_SOURCE_BYTES,
  READER_IMAGES_MAX_BYTES,
  READER_IMAGES_MAX_COUNT,
  type ReaderImageEntry,
  type ReaderImageSource,
  withinReaderImageBudget,
} from '@stxapps/shared';

import { encodeReaderImage } from './reader-image';

// Fetch and encode the images of ONE article — the step between a capture that came
// back with addresses (`readerCaptureFromPage`, or the extractor's `readModeImages`)
// and a stored copy (store-read-mode.ts). docs/link-extraction-keep.md, _images in
// read mode_.
//
// HOW the bytes are fetched is the caller's, because that is the one thing that
// differs by client: the browser extension fetches inside the page it is capturing,
// bracemark-web through the extractor's image proxy. Everything else is here, so both
// keep the same images of the same article:
//
//   - a few at a time, in page order, under ONE deadline for the whole article. The
//     text copy is already in hand and must not wait on a slow image host for longer
//     than the caller chose; whatever isn't in by then is a placeholder;
//   - an image that can't be had — the fetch failed or was refused, the bytes are over
//     the source ceiling, or `encodeReaderImage` refused them — is simply absent from
//     the result. NEVER a throw: a missing picture must not cost the article its text;
//   - it stops asking once the byte budget is spent, and the result is cut to the
//     budget in page order (`withinReaderImageBudget`).
//
// `fetchBytes` answers undefined (or rejects) for an image it couldn't get, and should
// give up when `signal` aborts — that is the deadline.
export interface CollectReaderImagesOptions {
  deadlineMs?: number;
  concurrency?: number;
  // At most this many addresses are tried — for a path where each fetch is a rated
  // request (the extractor's proxy). The pack's own count ceiling applies regardless.
  maxCount?: number;
}

const DEFAULT_DEADLINE_MS = 20_000;
const DEFAULT_CONCURRENCY = 4;

export async function collectReaderImages(
  sources: readonly ReaderImageSource[],
  fetchBytes: (url: string, signal: AbortSignal) => Promise<Uint8Array | undefined>,
  options: CollectReaderImagesOptions = {},
): Promise<ReaderImageEntry[]> {
  const {
    deadlineMs = DEFAULT_DEADLINE_MS,
    concurrency = DEFAULT_CONCURRENCY,
    maxCount = READER_IMAGES_MAX_COUNT,
  } = options;
  const wanted = sources.slice(0, Math.min(maxCount, READER_IMAGES_MAX_COUNT));
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
      try {
        const bytes = await fetchBytes(source.url, controller.signal);
        if (!bytes || bytes.length === 0 || bytes.length > READER_IMAGE_MAX_SOURCE_BYTES) continue;
        const encoded = await encodeReaderImage(bytes);
        if (typeof encoded === 'string') continue;
        found[index] = { key: source.key, ...encoded };
        total += encoded.bytes.length;
      } catch {
        // This image is a placeholder; the others are still worth having.
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, wanted.length) }, worker));
  } finally {
    clearTimeout(timer);
  }
  return withinReaderImageBudget(found.filter((entry) => entry !== undefined));
}
