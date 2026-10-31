import { z } from '../zod';

// The read-mode copy of a page — what `extraction.readModeId` names. A `files/{id}.enc`
// blob whose plaintext is this document as gzipped UTF-8 JSON (web-react
// `lib/reader-doc-bytes.ts` is the codec). See docs/link-extraction-keep.md.
//
// BLOCKS, NEVER HTML. A page is the least trusted input the product handles, and the
// read-mode copy is rendered inside the app that holds the data key — any markup that
// survived capture would be script on `app.bracemark.com`, and any remote `<img>` a
// request to the saved site on every render (the per-paint leak link-extraction.md's
// preview-image rule forbids). A list of typed blocks holding plain strings has no
// markup to sanitize: a renderer turns `text` into text nodes, and there is nothing
// else in here for it to turn into anything. It also renders natively on expo with no
// WebView, gives a highlight a stable anchor (`block.id` + an offset into its text),
// and gives search plain text to index.
//
// Every object is a `looseObject` and `kind` is a free string, for the reason the
// sync entities are: a newer client may add a block kind or a field, and an older one
// must round-trip the document rather than drop it. A renderer SKIPS a kind it doesn't
// know. And, as in entities.ts, no `.max()` anywhere: this schema parses stored bytes,
// so a cap here is a reader cap that silently empties a copy written before it
// (docs/data-limits.md — the tripwire). The caps live at the one writer, the capture
// (READER_DOC_MAX_BLOCKS / READER_DOC_MAX_CHARS below).

export const READER_DOC_VERSION = 1;

// The block kinds this version writes. A reader's switch is over these; anything else
// is a future kind and is skipped.
export const READER_BLOCK_KINDS = [
  'heading', // `level` 1–6, `runs`
  'paragraph', // `runs`
  'quote', // `runs` — one block per paragraph of a blockquote
  'listItem', // `runs`, `ordered`, `level` = nesting depth from 0
  'code', // `text`, whitespace preserved
  'figure', // an image the copy does NOT carry: `text` = its alt, `runs` = its caption
  'rule', // a thematic break, no content
] as const;
export type ReaderBlockKind = (typeof READER_BLOCK_KINDS)[number];

// A run of inline text with its marks. `href` is a link target and is only ever an
// absolute http(s) URL — the capture drops anything else, and a renderer re-checks with
// `isReaderHref` rather than trusting stored bytes (a backup is an outside file).
export const readerRunSchema = z.looseObject({
  text: z.string(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  code: z.boolean().optional(),
  href: z.string().optional(),
});
export type ReaderRun = z.infer<typeof readerRunSchema>;

export const readerBlockSchema = z.looseObject({
  // Stable within ONE document ('b0', 'b1', …, in reading order) — the anchor a
  // highlight stores. A re-capture renumbers, which is why a highlight also keeps the
  // text it quoted (docs/reader.md) and why a copy with highlights is never replaced
  // automatically.
  id: z.string(),
  kind: z.string(),
  level: z.number().int().optional(),
  ordered: z.boolean().optional(),
  runs: z.array(readerRunSchema).optional(),
  text: z.string().optional(),
});
export type ReaderBlock = z.infer<typeof readerBlockSchema>;

export const readerDocSchema = z.looseObject({
  version: z.number().int(),
  // What Readability found about the article, each optional and plain text.
  title: z.string().optional(),
  byline: z.string().optional(),
  siteName: z.string().optional(),
  excerpt: z.string().optional(),
  publishedTime: z.string().optional(),
  lang: z.string().optional(),
  dir: z.string().optional(), // 'ltr' | 'rtl' as the page declared it; anything else → ltr
  // The page the copy was taken from — the FINAL url after redirects, which may differ
  // from the link's. Informational; nothing is fetched from it.
  sourceUrl: z.string().optional(),
  capturedAt: z.number().int(),
  blocks: z.array(readerBlockSchema),
});
export type ReaderDoc = z.infer<typeof readerDocSchema>;

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

// The document's text in reading order, one block per line — what search would index
// and what a word count reads. Unknown kinds contribute what text they carry.
export function readerDocText(doc: Pick<ReaderDoc, 'blocks'>): string {
  return doc.blocks
    .map((block) => block.text ?? (block.runs ?? []).map((run) => run.text).join(''))
    .filter((line) => line !== '')
    .join('\n');
}
