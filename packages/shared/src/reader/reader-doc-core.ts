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
