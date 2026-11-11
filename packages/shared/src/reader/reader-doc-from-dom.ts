import type { ReaderBlock, ReaderCell, ReaderDoc, ReaderRun } from './reader-doc';
import {
  isReaderHref,
  isReaderImageTooSmall,
  READER_DOC_MAX_BLOCKS,
  READER_DOC_MAX_CHARS,
  READER_DOC_VERSION,
  READER_IMAGE_MAX_DIMENSION,
  READER_IMAGES_MAX_COUNT,
  READER_TABLE_MAX_COLUMNS,
  READER_TABLE_MAX_ROWS,
} from './reader-doc-core';
import type { ReaderImageSource } from './reader-images';

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
  'kind' | 'level' | 'ordered' | 'runs' | 'text' | 'rows' | 'truncated' | 'image'
>;

// Hands out the keys. One per distinct address (an image used twice is fetched once),
// and no more than READER_IMAGES_MAX_COUNT: past it a figure gets no key and stays a
// placeholder. Addresses are resolved against the page — Readability has made `src`
// and `srcset` absolute already, but a lazy-loading attribute it didn't recognise is
// still as the page wrote it — and anything that isn't http(s) afterwards is refused.
class ImageCollector {
  readonly sources: ReaderImageSource[] = [];
  private readonly byUrl = new Map<string, string>();

  constructor(private readonly base: string) {}

  keyFor(raw: string | undefined): string | undefined {
    if (!raw) return undefined;
    let url: string;
    try {
      url = new URL(raw.trim(), this.base).toString();
    } catch {
      return undefined;
    }
    if (!isReaderHref(url)) return undefined;
    const known = this.byUrl.get(url);
    if (known) return known;
    if (this.sources.length >= READER_IMAGES_MAX_COUNT) return undefined;
    const key = `i${this.sources.length}`;
    this.sources.push({ key, url });
    this.byUrl.set(url, key);
    return key;
  }
}
type BlockShape = Pick<BlockBody, 'kind' | 'level' | 'ordered' | 'text'>;

class Builder {
  readonly blocks: ReaderBlock[] = [];
  private chars = 0;

  // Present only on the document's own builder, and only when the caller asked for
  // images (`readerCaptureFromArticle`). The scratch builders a caption or a table
  // cell is collected in have none, so nothing inside them is ever given a key.
  constructor(readonly images?: ImageCollector) {}

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

// --- images -------------------------------------------------------------------

type SrcsetCandidate = { url: string; w?: number; x?: number };

// `srcset` as its candidates. Split on a comma FOLLOWED BY whitespace, not on every
// comma: image CDNs put commas inside the URL itself (`/w_800,q_70/a.jpg`).
function srcsetCandidates(srcset: string | null): SrcsetCandidate[] {
  if (!srcset) return [];
  return srcset.split(/,\s+/).flatMap((part): SrcsetCandidate[] => {
    const [url, descriptor] = part.trim().split(/\s+/);
    if (!url) return [];
    const match = /^(\d+(?:\.\d+)?)([wx])$/.exec(descriptor ?? '');
    if (!match) return [{ url }];
    return [match[2] === 'w' ? { url, w: Number(match[1]) } : { url, x: Number(match[1]) }];
  });
}

// The candidate to keep: the SMALLEST one that still fills the stored size, so the
// fetch is not a 4000 px original that is thrown away in the resize; failing that the
// largest there is. For density descriptors, 2× at most.
function pickCandidate(candidates: SrcsetCandidate[]): string | undefined {
  const widths = candidates.filter((c): c is SrcsetCandidate & { w: number } => c.w !== undefined);
  if (widths.length > 0) {
    widths.sort((a, b) => a.w - b.w);
    return (widths.find((c) => c.w >= READER_IMAGE_MAX_DIMENSION) ?? widths[widths.length - 1]).url;
  }
  const densities = candidates.filter(
    (c): c is SrcsetCandidate & { x: number } => c.x !== undefined,
  );
  if (densities.length > 0) {
    densities.sort((a, b) => a.x - b.x);
    return ([...densities].reverse().find((c) => c.x <= 2) ?? densities[0]).url;
  }
  return candidates[0]?.url;
}

// The attributes a lazy-loading page writes in place of `srcset` / `src`. Readability
// moves the common ones into place itself; these are for the page it didn't recognise.
const SRCSET_ATTRIBUTES = ['srcset', 'data-srcset', 'data-lazy-srcset'];
const SRC_ATTRIBUTES = ['src', 'data-src', 'data-lazy-src', 'data-original'];
// A `<source type>` no client here is sure to decode. The `<img>` beside it is the
// page's own fallback for exactly that case.
const UNDECODABLE_SOURCE = /avif|heic|heif|jxl|svg/i;

function fromSrcset(el: DomElement): string | undefined {
  for (const name of SRCSET_ATTRIBUTES) {
    const url = pickCandidate(srcsetCandidates(el.getAttribute(name)));
    if (url) return url;
  }
  return undefined;
}

// Where an image's bytes are, as the page wrote it — or undefined for one not worth
// asking for: no address but an inline `data:` one (a lazy-loader's blank), or a
// declared size that says icon. The real floor is applied again after the decode,
// since most pages size their images in CSS and declare nothing.
function imageAddress(img: DomElement, picture: DomElement | null): string | undefined {
  const width = Number(img.getAttribute('width'));
  const height = Number(img.getAttribute('height'));
  if (width > 0 && height > 0 && isReaderImageTooSmall(width, height)) return undefined;

  const own = fromSrcset(img);
  if (own) return own;
  if (picture) {
    for (const source of Array.from(picture.querySelectorAll('source'))) {
      if (UNDECODABLE_SOURCE.test(source.getAttribute('type') ?? '')) continue;
      const url = fromSrcset(source);
      if (url) return url;
    }
  }
  for (const name of SRC_ATTRIBUTES) {
    const value = img.getAttribute(name)?.trim();
    if (value && !/^data:/i.test(value)) return value;
  }
  return undefined;
}

// One image as a `figure` block: its alt, its caption, and — when the caller collects
// images — the key its bytes will be packed under. With none of the three there is
// nothing to show and no block. False when `el` holds no image at all, so the caller
// walks it as the container it is (a figure around a code listing, a quote).
function pushFigure(el: DomElement, tag: string, builder: Builder): boolean {
  const img = tag === 'IMG' ? el : el.querySelector('img');
  if (!img) return false;
  if (builder.full) return true;
  const picture = tag === 'PICTURE' ? el : tag === 'FIGURE' ? el.querySelector('picture') : null;
  const alt = (img.getAttribute('alt') ?? '').trim();
  const runs = tag === 'FIGURE' ? captionOf(el) : [];
  const image = builder.images?.keyFor(imageAddress(img, picture));
  if (alt !== '' || runs.length > 0 || image) {
    builder.push({
      kind: 'figure',
      ...(alt ? { text: alt } : {}),
      runs,
      ...(image ? { image } : {}),
    });
  }
  return true;
}

// The images in an element that holds NOTHING ELSE — `<p><img></p>`, `<a><img></a>`,
// the way most pages wrap a picture. Those are figures. An image in among words (an
// emoji, an inline icon) is not: promoting it would cut the sentence in two around a
// placeholder, so it is left where every image used to be left, out of the copy.
function imagesAlone(el: DomElement): DomElement[] {
  if ((el.textContent ?? '').trim() !== '') return [];
  return Array.from(el.querySelectorAll('img'));
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
      if (tag === 'BR') {
        builder.text('\n', {}, true);
        continue;
      }
      const images = imagesAlone(el);
      if (images.length === 0) {
        walkInline(el, builder, inlineMarks(el, {}));
        continue;
      }
      builder.close();
      for (const img of images) pushFigure(img, 'IMG', builder);
      builder.open({ kind: paragraphKind });
      continue;
    }

    builder.close();
    const level = HEADINGS[tag];
    if (level !== undefined) {
      builder.open({ kind: 'heading', level });
      walkInline(el, builder, {});
    } else if (tag === 'P') {
      const images = imagesAlone(el);
      if (images.length > 0) {
        for (const img of images) pushFigure(img, 'IMG', builder);
      } else {
        builder.open({ kind: paragraphKind });
        walkInline(el, builder, {});
      }
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
      // The document never carries a remote URL (rendering one would be a request to
      // the site per view): a figure is the words the image had, and a KEY when the
      // caller is collecting images to keep (_images_, above). A figure wrapping
      // something other than an image (a code listing, a quote) is walked as a
      // container instead, and so is one holding several images — a gallery — so each
      // becomes a figure of its own.
      const gallery = tag === 'FIGURE' && el.querySelectorAll('img').length > 1;
      if (gallery || !pushFigure(el, tag, builder)) walkBlocks(el, builder, ctx);
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
  return build(body, article, sourceUrl, now, undefined);
}

// The same document, with the images it could keep: every figure the walker found an
// address for carries a key (`block.image`), and `images` pairs each key with that
// address. A capture that keeps images calls this, fetches what it can, and then runs
// the document through `applyReaderImages` (reader-images.ts) — which is what removes
// the key from a figure whose image was not kept. The addresses are for that one
// fetch; they are not in the document and must never be stored.
export function readerCaptureFromArticle(
  body: DomNode,
  article: ReaderArticleMeta,
  sourceUrl: string,
  now = Date.now(),
): { doc: ReaderDoc; images: ReaderImageSource[] } | null {
  const collector = new ImageCollector(sourceUrl);
  const doc = build(body, article, sourceUrl, now, collector);
  return doc ? { doc, images: collector.sources } : null;
}

function build(
  body: DomNode,
  article: ReaderArticleMeta,
  sourceUrl: string,
  now: number,
  images: ImageCollector | undefined,
): ReaderDoc | null {
  const builder = new Builder(images);
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
