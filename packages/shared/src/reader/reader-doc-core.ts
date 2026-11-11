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
