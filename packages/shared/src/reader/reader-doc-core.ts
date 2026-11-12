// The zod-free half of reader-doc.ts — the version, the writer's caps and the link
// check. Split out so the capture bundles that run INSIDE a page (the browser
// extension's injected file, the iOS share preprocessing, expo's WebView capture —
// tools/scripts/generate-reader-capture.ts) can take these without taking zod and
// the schemas with them. reader-doc.ts re-exports everything here; import from there
// (or the package barrel) everywhere else.

export const READER_DOC_VERSION = 1;

// The writer's ceilings — enforced by the capture, never by the schema (above). Sized
// far past any article (a long-read is a few hundred blocks and ~100k characters) so
// they only ever bind on a page that isn't one: an endless feed Readability took for
// content. Past either, the capture stops at the block that crossed it.
export const READER_DOC_MAX_BLOCKS = 10_000;
export const READER_DOC_MAX_CHARS = 1_000_000;

// A `table` block's own ceilings — the capture's too, never the schema's. The two bind
// differently, on purpose. A table WIDER than the column cap is not kept as a grid at
// all: a reader scrolls a grid sideways, and past a couple of dozen columns that is a
// spreadsheet, not a figure in an article, so its cells are walked as ordinary content
// instead. A table LONGER than the row cap is cut there and marked `truncated`, so the
// reader can say the rest was not kept rather than end as if the table did.
export const READER_TABLE_MAX_COLUMNS = 24;
export const READER_TABLE_MAX_ROWS = 500;

// The capture crosses a process boundary as JSON TEXT — Safari → the iOS share
// extension, or a WebView → the app's JS — and past this many characters it is dropped
// rather than sent. Far above any article (READER_DOC_MAX_CHARS bounds the text at 1M),
// it only binds on a pathological page; the share extension has ~120 MB to work in.
// One number for both generated scripts (tools/scripts/generate-reader-capture.ts).
export const READER_CAPTURE_MAX_PAYLOAD_CHARS = 3_000_000;

// The STORE EDGE's ceilings, for a copy that did not come from this build's walker: a
// forged WebView message, a Safari draft, a backup, a blob from another device. The
// walker's caps above bind where the walker is trusted to run; on the WebView and Safari
// doors it runs in the page, so they bind nothing there (docs/link-extraction-keep.md,
// _the format tripwire_). What every honest writer's output stays inside, with room: the
// blocks the walker stops at, the payload cap the crossings enforce, the table ceilings.
// A copy past one is not an article, and is not kept. The decompressed size is the
// reader's own ceiling, so a few KB of gzip cannot become a gigabyte at open.
export const READER_STORE_MAX_BLOCKS = READER_DOC_MAX_BLOCKS;
export const READER_STORE_MAX_CHARS = 3_000_000;
export const READER_DOC_MAX_JSON_BYTES = 32 * 1024 * 1024;

// --- images (docs/link-extraction-keep.md, _images in read mode_) -------------------
//
// The ceilings on the images a read-mode copy keeps — the capture's, like every cap
// here. They bound three different things:
//
//   - WHICH images are asked for: at most READER_IMAGES_MAX_COUNT addresses leave the
//     walker, so an article that is a gallery of 400 thumbnails is 30 fetches, not 400;
//   - what one image may cost to FETCH: READER_IMAGE_MAX_SOURCE_BYTES, the preview
//     path's own ceiling, checked before the bytes are decoded;
//   - what is STORED: each image is re-encoded to a JPEG no longer than
//     READER_IMAGE_MAX_DIMENSION on its longest side, and the pack stops taking images
//     at READER_IMAGES_MAX_BYTES — past it, a figure stays the placeholder it would be
//     with images off. The dimension is the preview's: a reader column is ~700 CSS px,
//     so 1024 is what a 1.5× screen can show and a 2× screen barely misses.
//
// And one floor: an image smaller than READER_IMAGE_MIN_AREA, or thinner than
// READER_IMAGE_MIN_SIDE on either side, is an icon, an avatar, a spacer or a tracking
// pixel — never the figure a paragraph is about. Area rather than a square, so a wide
// formula or a sparkline (300×40) is kept and a 48×48 avatar is not.
export const READER_IMAGES_MAX_COUNT = 30;
export const READER_IMAGES_MAX_BYTES = 4 * 1024 * 1024;
export const READER_IMAGE_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const READER_IMAGE_MAX_DIMENSION = 1024;
export const READER_IMAGE_JPEG_QUALITY = 0.8;
export const READER_IMAGE_MIN_AREA = 100 * 100;
export const READER_IMAGE_MIN_SIDE = 32;
// The pack's index is ~100 bytes an image; this is far past 30 of them. A decoder reads
// the index into a string, so its length is a bound worth having.
export const READER_IMAGES_MAX_INDEX_BYTES = 64 * 1024;

export function isReaderImageTooSmall(width: number, height: number): boolean {
  return width * height < READER_IMAGE_MIN_AREA || Math.min(width, height) < READER_IMAGE_MIN_SIDE;
}

// Is this a link target a reader may render as a link? Absolute http(s) only: no
// `javascript:`, no `data:`, nothing relative (there is no base to resolve against in
// the app). Used by the capture to drop a target and by a renderer to refuse one.
export function isReaderHref(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const { protocol } = new URL(href);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
