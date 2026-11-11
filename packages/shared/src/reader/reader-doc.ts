import { z } from '../zod';

export {
  isReaderHref,
  READER_DOC_MAX_BLOCKS,
  READER_DOC_MAX_CHARS,
  READER_DOC_VERSION,
  READER_TABLE_MAX_COLUMNS,
  READER_TABLE_MAX_ROWS,
} from './reader-doc-core';

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
// (READER_DOC_MAX_BLOCKS / READER_DOC_MAX_CHARS, in reader-doc-core.ts).

// The block kinds this version writes. A reader's switch is over these; anything else
// is a future kind and is skipped.
export const READER_BLOCK_KINDS = [
  'heading', // `level` 1–6, `runs`
  'paragraph', // `runs`
  'quote', // `runs` — one block per paragraph of a blockquote
  'listItem', // `runs`, `ordered`, `level` = nesting depth from 0
  'code', // `text`, whitespace preserved
  'figure', // an image the copy does NOT carry: `text` = its alt, `runs` = its caption
  'table', // `rows` of `cells`, a rectangular grid; `runs` = its caption; `truncated`
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

// A table's cell: inline runs, exactly what a paragraph holds — a cell that was several
// paragraphs or a list on the page is ONE run list with `\n` between the pieces. No
// blocks inside a cell: nesting would give the format a second tree to walk, cap and
// anchor into, for the few tables that need it. `header` is a `<th>` or any cell of a
// `<thead>` row.
//
// `runs` and a row's `cells` are OPTIONAL in the schema though the capture always
// writes them, for the reason `kind` is a free string: this parses stored bytes, and
// a parse that fails drops the WHOLE copy as unreadable. A newer client that gives a
// cell something other than runs must cost an older reader that cell, not the article.
export const readerCellSchema = z.looseObject({
  runs: z.array(readerRunSchema).optional(),
  header: z.boolean().optional(),
});
export type ReaderCell = z.infer<typeof readerCellSchema>;

// A row is an object, not a bare array of cells, for the reason every level here is a
// looseObject: a newer client may hang a field on a row, and an array has nowhere to
// put one.
export const readerRowSchema = z.looseObject({
  cells: z.array(readerCellSchema).optional(),
});
export type ReaderRow = z.infer<typeof readerRowSchema>;

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
  // `table` only. The grid is RECTANGULAR as written: the capture expands every
  // colspan/rowspan into empty cells and pads short rows, so every row has the same
  // number of cells and a renderer never computes a span. A renderer still must not
  // ASSUME it (a backup is an outside file) — it reads each row's own cells.
  rows: z.array(readerRowSchema).optional(),
  // `table` only: the page's table had more rows than the capture keeps
  // (READER_TABLE_MAX_ROWS), and this is the first part of it.
  truncated: z.boolean().optional(),
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

const runsText = (runs: ReaderRun[] | undefined): string =>
  (runs ?? []).map((run) => run.text).join('');

// When the page says the article was published, as a time — or undefined when it gave
// none, gave one `Date.parse` can't read (pages write this field every way there is),
// or gave one later than the copy itself, which is a page's mistake rather than a
// date worth printing. For the reader's line under the title; nothing sorts on it.
export function readerPublishedAt(
  doc: Pick<ReaderDoc, 'publishedTime' | 'capturedAt'>,
): number | undefined {
  if (!doc.publishedTime) return undefined;
  const at = Date.parse(doc.publishedTime);
  if (!Number.isFinite(at) || at <= 0) return undefined;
  // A day of slack for a page that stamps its local date without a zone.
  return at <= doc.capturedAt + 24 * 60 * 60 * 1000 ? at : undefined;
}

// The document's text in reading order, one block per line — what search would index
// and what a word count reads. Unknown kinds contribute what text they carry. A table
// is its caption, then one line per row with a tab between cells (a cell's own line
// breaks become spaces, so a row stays one line).
export function readerDocText(doc: Pick<ReaderDoc, 'blocks'>): string {
  return doc.blocks
    .flatMap((block) => [
      block.text ?? runsText(block.runs),
      ...(block.rows ?? []).map((row) =>
        (row.cells ?? []).map((cell) => runsText(cell.runs).replace(/\s*\n\s*/g, ' ')).join('\t'),
      ),
    ])
    .filter((line) => line.trim() !== '')
    .join('\n');
}
