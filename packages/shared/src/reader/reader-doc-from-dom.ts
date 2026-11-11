import type { ReaderBlock, ReaderCell, ReaderDoc, ReaderRun } from './reader-doc';
import {
  isReaderHref,
  READER_DOC_MAX_BLOCKS,
  READER_DOC_MAX_CHARS,
  READER_DOC_VERSION,
  READER_TABLE_MAX_COLUMNS,
  READER_TABLE_MAX_ROWS,
} from './reader-doc-core';

// The second half of every read-mode capture: Readability's article HTML, already parsed
// into an inert DOM, turned into `ReaderDoc` blocks — plain strings with marks — so no
// markup a page wrote survives into storage (reader-doc.ts says why that is the whole
// point). ONE walker for every client that captures, so a page reads the same whichever
// tier took it — a tier upgrade or a second capture is an improvement, never a different
// text:
//
//   - in a live page — the browser extension's injected file, the iOS share
//     preprocessing, expo's WebView capture — through web-react's
//     `lib/reader-doc-from-page.ts`, over the browser's own DOM;
//   - on the server — bracemark-extractor's `lib/read-mode.ts`, over linkedom's.
//
// It lives HERE, in the agnostic layer, because the extractor is `platform:worker` and
// may not import web-react; and it is written against the few DOM members it reads
// (`DomNode`, `DomElement` below), not lib.dom, for the same reason — the shared
// tsconfig has no DOM, and neither does a Worker. Two consequences for anyone editing
// it: compare `nodeType` with the numbers (there is no `Node` global on a Worker), and
// never reach for a global (`document`, `DOMParser`) — the caller parses, this walks.
//
// ZOD-FREE, like reader-doc-core.ts, and reached through its own subpath export, never
// the barrel: the live-page captures bundle it into scripts that run inside a
// stranger's page (docs/architecture.md, _the barrel is the API — except where a barrel
// is the cost_). Type-only imports from reader-doc.ts are erased at build.
//
// The capture scripts embed this file, so it is a hash input of
// tools/scripts/generate-reader-capture.ts: edit it and regenerate.

// The DOM members the walker reads — what a browser `Element` and a linkedom element
// both have. `nodeType` 1 is an element, 3 a text node.
export interface DomNode {
  readonly nodeType: number;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<DomNode>;
}

export interface DomElement extends DomNode {
  readonly tagName: string;
  readonly localName: string;
  readonly children: ArrayLike<DomElement>;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): ArrayLike<DomElement>;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const isElement = (node: DomNode): node is DomElement => node.nodeType === ELEMENT_NODE;

// Elements whose content is never article text, even inside what Readability kept.
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED']);
const SKIP_SVG = 'svg';
const HEADINGS: Record<string, number> = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 };
// Block-level elements: entering one closes the paragraph being collected.
const BLOCKS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'FORM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PICTURE',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

// `tagName` is upper case for an HTML element in every DOM this runs on, but a parser
// that kept the source's case would make every lookup above miss — so normalize once.
const tagOf = (el: DomElement): string => el.tagName.toUpperCase();
const isSkipped = (el: DomElement): boolean => SKIP.has(tagOf(el)) || el.localName === SKIP_SVG;

type Marks = Pick<ReaderRun, 'bold' | 'italic' | 'code' | 'href'>;
// A block before it is numbered. Spelled out rather than `Omit<ReaderBlock, 'id'>`:
// the schema is a looseObject, and Omit over its index signature keeps only that.
type BlockBody = Pick<
  ReaderBlock,
  'kind' | 'level' | 'ordered' | 'runs' | 'text' | 'rows' | 'truncated'
>;
type BlockShape = Pick<BlockBody, 'kind' | 'level' | 'ordered' | 'text'>;

class Builder {
  readonly blocks: ReaderBlock[] = [];
  private chars = 0;
  // The inline runs of the block being collected, and what kind it becomes when closed.
  private runs: ReaderRun[] = [];
  private pending: BlockShape = { kind: 'paragraph' };

  get full(): boolean {
    return this.blocks.length >= READER_DOC_MAX_BLOCKS || this.chars >= READER_DOC_MAX_CHARS;
  }

  // Start collecting inline content for a block of this shape (closing any open one).
  open(shape: BlockShape): void {
    this.close();
    this.pending = shape;
  }

  text(raw: string, marks: Marks, preserve = false): void {
    let text = preserve ? raw : raw.replace(/\s+/g, ' ');
    const last = this.runs[this.runs.length - 1];
    // Collapsed whitespace at the start of a LINE is the source's indentation, not
    // content: the space after a `<br>`, or between two block children of a table
    // cell. CSS drops it on web; a native `<Text>` would draw it as an indent.
    if (!preserve && (!last || last.text.endsWith('\n'))) text = text.replace(/^ /, '');
    if (text === '') return;
    if (last && sameMarks(last, marks)) {
      last.text += text;
      return;
    }
    this.runs.push({ text, ...definedMarks(marks) });
  }

  // A line break between two pieces that were separate blocks on the page — the
  // paragraphs or list items inside one table cell, which a cell holds as ONE run
  // list. Never doubled, never leading: two block boundaries in a row are one break,
  // and the space the source had before it goes.
  lineBreak(): void {
    let last = this.runs[this.runs.length - 1];
    while (last) {
      last.text = last.text.replace(/[ \t]+$/, '');
      if (last.text !== '') break;
      this.runs.pop();
      last = this.runs[this.runs.length - 1];
    }
    if (!last || last.text.endsWith('\n')) return;
    this.text('\n', {}, true);
  }

  // Close the open block: trim its edges, drop it if nothing is left, number it.
  close(): void {
    const runs = trimRuns(this.runs);
    this.runs = [];
    const shape = this.pending;
    this.pending = { kind: 'paragraph' };
    if (runs.length === 0) return;
    this.push({ ...shape, runs });
  }

  push(block: BlockBody): void {
    if (this.full) return;
    this.chars += (block.text ?? '').length;
    for (const run of block.runs ?? []) this.chars += run.text.length;
    for (const row of block.rows ?? []) {
      for (const cell of row.cells ?? []) {
        for (const run of cell.runs ?? []) this.chars += run.text.length;
      }
    }
    this.blocks.push({ id: `b${this.blocks.length}`, ...block });
  }
}

function definedMarks(marks: Marks): Marks {
  const out: Marks = {};
  if (marks.bold) out.bold = true;
  if (marks.italic) out.italic = true;
  if (marks.code) out.code = true;
  if (marks.href) out.href = marks.href;
  return out;
}

function sameMarks(run: ReaderRun, marks: Marks): boolean {
  return (
    !!run.bold === !!marks.bold &&
    !!run.italic === !!marks.italic &&
    !!run.code === !!marks.code &&
    run.href === marks.href
  );
}

// Trim whitespace off the block's two ends (inside runs, a collapsed space between
// words is content) and drop runs that end up empty.
function trimRuns(runs: ReaderRun[]): ReaderRun[] {
  const out = runs.map((run) => ({ ...run }));
  while (out.length > 0) {
    out[0].text = out[0].text.replace(/^\s+/, '');
    if (out[0].text !== '') break;
    out.shift();
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    last.text = last.text.replace(/\s+$/, '');
    if (last.text !== '') break;
    out.pop();
  }
  return out;
}

function inlineMarks(el: DomElement, marks: Marks): Marks {
  switch (tagOf(el)) {
    case 'B':
    case 'STRONG':
      return { ...marks, bold: true };
    case 'I':
    case 'EM':
    case 'CITE':
      return { ...marks, italic: true };
    case 'CODE':
    case 'KBD':
    case 'SAMP':
      return { ...marks, code: true };
    case 'A': {
      // Readability has already made relative hrefs absolute against the document's
      // base URL — which is why the server sets one before it runs (lib/read-mode.ts).
      const href = el.getAttribute('href') ?? undefined;
      return { ...marks, href: isReaderHref(href) ? href : undefined };
    }
    default:
      return marks;
  }
}

function captionOf(figure: DomElement): ReaderRun[] {
  const caption = figure.querySelector('figcaption');
  if (!caption) return [];
  const builder = new Builder();
  builder.open({ kind: 'paragraph' });
  walkInline(caption, builder, {});
  builder.close();
  return builder.blocks[0]?.runs ?? [];
}

function walkInline(node: DomNode, builder: Builder, marks: Marks, preserve = false): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      builder.text(child.textContent ?? '', marks, preserve);
    } else if (isElement(child)) {
      if (isSkipped(child)) continue;
      if (tagOf(child) === 'BR') builder.text('\n', marks, true);
      else walkInline(child, builder, inlineMarks(child, marks), preserve);
    }
  }
}

// --- tables -------------------------------------------------------------------
//
// A data table becomes ONE `table` block: a rectangular grid of cells, each cell a run
// list. Everything else that is written with `<table>` — a layout table, a one-column
// or one-row "table", a table holding another table, a grid wider than the column cap
// — is not a grid a reader should draw, and its cells are walked as ordinary content
// (`walkBlocks`, which descends through TBODY/TR/TD like any container).

// A cell's content as one run list. Inline content is walked as anywhere else; a
// block-level child (a `<p>`, an `<li>`, a `<div>`) and a `<br>` become line breaks,
// so two paragraphs in a cell don't run together as one word.
function walkCell(node: DomNode, builder: Builder, marks: Marks): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      builder.text(child.textContent ?? '', marks);
    } else if (isElement(child)) {
      if (isSkipped(child)) continue;
      const tag = tagOf(child);
      if (tag === 'BR') {
        builder.lineBreak();
      } else if (BLOCKS.has(tag)) {
        builder.lineBreak();
        walkCell(child, builder, marks);
        builder.lineBreak();
      } else {
        walkCell(child, builder, inlineMarks(child, marks));
      }
    }
  }
}

function cellRuns(cell: DomElement): ReaderRun[] {
  const builder = new Builder();
  builder.open({ kind: 'paragraph' });
  walkCell(cell, builder, {});
  builder.close();
  return builder.blocks[0]?.runs ?? [];
}

// The table's OWN rows, head first and foot last whatever order the source wrote them
// in — never `querySelectorAll('tr')`, which would also return the rows of a table
// nested inside a cell.
function tableRows(table: DomElement): { row: DomElement; head: boolean }[] {
  const head: { row: DomElement; head: boolean }[] = [];
  const body: { row: DomElement; head: boolean }[] = [];
  const foot: { row: DomElement; head: boolean }[] = [];
  for (const child of Array.from(table.children)) {
    const tag = tagOf(child);
    if (tag === 'TR') {
      body.push({ row: child, head: false });
    } else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
      const into = tag === 'THEAD' ? head : tag === 'TFOOT' ? foot : body;
      for (const row of Array.from(child.children)) {
        if (tagOf(row) === 'TR') into.push({ row, head: tag === 'THEAD' });
      }
    }
  }
  return [...head, ...body, ...foot];
}

function spanOf(cell: DomElement, name: 'colspan' | 'rowspan'): number {
  const span = Number.parseInt(cell.getAttribute(name) ?? '', 10);
  return Number.isFinite(span) && span > 1 ? span : 1;
}

// The `table` block for a data table, or null when this is not one (above). Spans are
// EXPANDED here, at the one writer: a cell spanning three columns is its content
// followed by two empty cells, and a rowspan leaves an empty cell in each row below —
// so the stored grid is rectangular and neither renderer (an HTML table on web, plain
// Views on expo, which has no table at all) ever has to lay a span out.
function tableBlock(table: DomElement): BlockBody | null {
  if (table.querySelector('table')) return null;
  const source = tableRows(table);
  if (source.length < 2) return null;

  const truncated = source.length > READER_TABLE_MAX_ROWS;
  const count = Math.min(source.length, READER_TABLE_MAX_ROWS);
  const grid: (ReaderCell | undefined)[][] = Array.from({ length: count }, () => []);
  for (let r = 0; r < count; r++) {
    const line = grid[r];
    let c = 0;
    for (const cell of Array.from(source[r].row.children)) {
      const tag = tagOf(cell);
      if (tag !== 'TD' && tag !== 'TH') continue;
      // Skip the slots a rowspan from above already filled.
      while (line[c] !== undefined) c++;
      const colSpan = spanOf(cell, 'colspan');
      const rowSpan = spanOf(cell, 'rowspan');
      if (c + colSpan > READER_TABLE_MAX_COLUMNS) return null;
      const header = tag === 'TH' || source[r].head;
      for (let dr = 0; dr < rowSpan && r + dr < count; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          const first = dr === 0 && dc === 0;
          grid[r + dr][c + dc] ??= {
            runs: first ? cellRuns(cell) : [],
            ...(header ? { header: true } : {}),
          };
        }
      }
      c += colSpan;
    }
  }

  const width = Math.max(...grid.map((line) => line.length));
  if (width < 2) return null;
  // Pad short rows and fill the holes a ragged source left, so every row is `width`.
  const rows = grid.map((line) => ({
    cells: Array.from({ length: width }, (_, c): ReaderCell => line[c] ?? { runs: [] }),
  }));
  if (rows.every((row) => row.cells.every((cell) => (cell.runs ?? []).length === 0))) return null;

  const caption = Array.from(table.children).find((child) => tagOf(child) === 'CAPTION');
  const runs = caption ? cellRuns(caption) : [];
  return {
    kind: 'table',
    rows,
    ...(runs.length > 0 ? { runs } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

// Walk a container's children: inline content accumulates into the open block, and a
// block-level child closes it and is handled by kind.
function walkBlocks(node: DomNode, builder: Builder, ctx: { quote: boolean; depth: number }): void {
  const paragraphKind = ctx.quote ? 'quote' : 'paragraph';
  builder.open({ kind: paragraphKind });
  for (const child of Array.from(node.childNodes)) {
    if (builder.full) return;
    if (child.nodeType === TEXT_NODE) {
      builder.text(child.textContent ?? '', {});
      continue;
    }
    if (!isElement(child)) continue;
    const el = child;
    const tag = tagOf(el);
    if (isSkipped(el)) continue;
    if (!BLOCKS.has(tag) && tag !== 'IMG') {
      if (tag === 'BR') builder.text('\n', {}, true);
      else walkInline(el, builder, inlineMarks(el, {}));
      continue;
    }

    builder.close();
    const level = HEADINGS[tag];
    if (level !== undefined) {
      builder.open({ kind: 'heading', level });
      walkInline(el, builder, {});
    } else if (tag === 'P') {
      builder.open({ kind: paragraphKind });
      walkInline(el, builder, {});
    } else if (tag === 'BLOCKQUOTE') {
      walkBlocks(el, builder, { ...ctx, quote: true });
    } else if (tag === 'UL' || tag === 'OL') {
      const ordered = tag === 'OL';
      for (const item of Array.from(el.children)) {
        if (tagOf(item) !== 'LI') continue;
        walkListItem(item, builder, { ordered, depth: ctx.depth });
      }
    } else if (tag === 'PRE') {
      const text = (el.textContent ?? '').replace(/^\n+|\s+$/g, '');
      if (text !== '') builder.push({ kind: 'code', text });
    } else if (tag === 'HR') {
      builder.push({ kind: 'rule' });
    } else if (tag === 'IMG' || tag === 'FIGURE' || tag === 'PICTURE') {
      // The copy carries no image bytes and never a remote URL (rendering one would be
      // a request to the site per view): a placeholder with what words it had. A
      // figure wrapping something other than an image (a code listing, a quote) is
      // walked as a container instead.
      const img = tag === 'IMG' ? el : el.querySelector('img');
      if (img) {
        const alt = (img.getAttribute('alt') ?? '').trim();
        const runs = tag === 'FIGURE' ? captionOf(el) : [];
        if (alt !== '' || runs.length > 0) {
          builder.push({ kind: 'figure', ...(alt ? { text: alt } : {}), runs });
        }
      } else {
        walkBlocks(el, builder, ctx);
      }
    } else if (tag === 'TABLE') {
      // A data table is one `table` block; anything else written with `<table>` is
      // walked as the containers it is (_tables_, above).
      const table = tableBlock(el);
      if (table) builder.push(table);
      else walkBlocks(el, builder, ctx);
    } else {
      walkBlocks(el, builder, ctx);
    }
    builder.open({ kind: paragraphKind });
  }
  builder.close();
}

function walkListItem(
  item: DomElement,
  builder: Builder,
  list: { ordered: boolean; depth: number },
): void {
  builder.open({ kind: 'listItem', ordered: list.ordered, level: list.depth });
  for (const child of Array.from(item.childNodes)) {
    if (isElement(child)) {
      const tag = tagOf(child);
      if (tag === 'UL' || tag === 'OL') {
        builder.close();
        const ordered = tag === 'OL';
        for (const nested of Array.from(child.children)) {
          if (tagOf(nested) === 'LI') {
            walkListItem(nested, builder, { ordered, depth: list.depth + 1 });
          }
        }
        // Text after a nested list continues the item, as a further item line.
        builder.open({ kind: 'listItem', ordered: list.ordered, level: list.depth });
        continue;
      }
      if (isSkipped(child)) continue;
      if (tag === 'BR') builder.text('\n', {}, true);
      else walkInline(child, builder, inlineMarks(child, {}));
    } else if (child.nodeType === TEXT_NODE) {
      builder.text(child.textContent ?? '', {});
    }
  }
  builder.close();
}

// What Readability's `parse()` returns beside the article HTML — the fields a
// `ReaderDoc` keeps, each optional plain text. Typed here rather than imported so this
// file needs neither Readability nor its DOM-typed declarations.
export interface ReaderArticleMeta {
  title?: string | null;
  byline?: string | null;
  siteName?: string | null;
  excerpt?: string | null;
  publishedTime?: string | null;
  lang?: string | null;
  dir?: string | null;
}

const optional = (value: string | null | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

// The document for one article: `body` is Readability's `content`, parsed by the caller
// into an INERT document (the browser's DOMParser, linkedom's parseHTML — nothing in it
// runs or loads); `sourceUrl` the page it came from, after redirects. Null when the
// article has no text the walker keeps — a caller records that as "not an article",
// settled, exactly as when Readability finds none.
export function readerDocFromArticle(
  body: DomNode,
  article: ReaderArticleMeta,
  sourceUrl: string,
  now = Date.now(),
): ReaderDoc | null {
  const builder = new Builder();
  walkBlocks(body, builder, { quote: false, depth: 0 });
  if (builder.blocks.length === 0) return null;

  const doc: ReaderDoc = {
    version: READER_DOC_VERSION,
    capturedAt: now,
    sourceUrl,
    blocks: builder.blocks,
  };
  const fields = {
    title: optional(article.title),
    byline: optional(article.byline),
    siteName: optional(article.siteName),
    excerpt: optional(article.excerpt),
    publishedTime: optional(article.publishedTime),
    lang: optional(article.lang),
    dir: optional(article.dir),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (doc as Record<string, unknown>)[key] = value;
  }
  return doc;
}
