import { isProbablyReaderable, Readability } from '@mozilla/readability';
import { Parser } from 'htmlparser2';
import { parseHTML } from 'linkedom';

import type { ReaderDoc, ReaderImageSource } from '@stxapps/shared';
import { type DomNode, readerCaptureFromArticle } from '@stxapps/shared/reader/reader-doc-from-dom';

// Server read mode: the page's HTML → a `ReaderDoc`, with the SAME two steps every
// live-page capture takes (web-react lib/reader-doc-from-page.ts) — Readability finds
// the article, then the shared walker (@stxapps/shared reader/reader-doc-from-dom.ts)
// turns it into blocks of plain text — so a copy reads the same whichever tier took it.
// The difference is the DOM: a Worker has none, so linkedom builds one from the string.
//
// Nothing here runs or loads. linkedom is a parser that builds a tree — it executes no
// script, fetches no stylesheet, image or frame, and has no network of its own; the only
// fetch on this path is the page itself, in routes/extract.ts, under safeFetch. And the
// output is the walker's, which keeps no markup: blocks of strings, and only absolute
// http(s) link targets (the keep doc's format tripwire).
//
// What a raw-HTML read can't see, it can't keep: a page assembled by script carries no
// article in its HTML, so Readability finds none and the result says `not-an-article`
// (a settled answer for this tier — a browser-extension capture of the live page is the
// upgrade). And the HTML is the first MAX_HTML_BYTES of the response, so an article
// longer than that ends where the read did.
//
// Readability's declarations are typed against lib.dom's `Document`, which a Worker's
// tsconfig doesn't have; linkedom's document is the runtime stand-in, hence the casts.

// The document's base URL, set the way a browser derives it: the page's own `<base
// href>` resolved against the address it was served from, or that address. linkedom has
// no document URL of its own, and Readability resolves every relative link against
// `document.baseURI` — without one, every relative href would survive as relative and
// the walker (which keeps absolute http(s) targets only) would drop it.
function setBaseUrl(document: ParsedDocument, finalUrl: URL): void {
  const existing = document.querySelector('base[href]');
  let base = finalUrl.toString();
  const declared = existing?.getAttribute('href');
  if (declared) {
    try {
      const resolved = new URL(declared, finalUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') base = resolved.href;
    } catch {
      // an unparseable <base> — the page's own address stands
    }
  }
  if (existing) {
    existing.setAttribute('href', base);
    return;
  }
  const element = document.createElement('base');
  element.setAttribute('href', base);
  const head = document.head ?? document.documentElement;
  head?.insertBefore(element, head.firstChild ?? null);
}

type ParsedDocument = ReturnType<typeof parseHTML>['document'];
// Whatever Readability's declarations call a document — lib.dom's `Document`, which
// this tsconfig doesn't load, so it's named through the constructor instead.
type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

// Null when the page isn't an article (Readability's pre-check, then its parse, then a
// walker that kept nothing) — the route answers `not-an-article`.
//
// NEVER a throw. Readability walks linkedom's tree, and on some pages it trips over a
// shape linkedom builds differently from a browser — an empty body, a page that is
// bare text, a document with no element at its root (`documentElement` null) — and
// throws from inside its own parse. Thrown, it reached the route's catch-all and came
// back a generic TRANSIENT failure, which the client asks again about, and which the
// same page answers the same way every time. Measured on 2 of 55 real pages
// (docs/link-extraction-server.md, _cost on the Worker_). A page Readability can't read
// is a page with no article we can keep: null.
//
// `images` is the address of every figure the document gave a key to — the client's to
// fetch through the image proxy (routes/image.ts), never this Worker's: fetching thirty
// images inside the extract request would hold it open past its deadline and inline
// megabytes into a JSON response. The walker has resolved each against the final URL.
// The most work a page may ask of read mode before it is called "not an article". The byte cap
// (MAX_HTML_BYTES) bounds what is READ, not what it COSTS, and a stranger picks the page. Three
// costs:
//
// - PARSING (linkedom's `parseHTML`, which is htmlparser2 underneath) costs time in the square of
//   the nesting: htmlparser2 keeps its open elements in an array it `unshift`s and searches, so
//   160,000 nested `<div>`s (950 KB) took 24 s. A page can nest that deep without writing a single
//   `<div>`: htmlparser2 ignores `/>` on an element that isn't void, leaves `<thead>` and
//   `<colgroup>` open, and closes a `<p>` or `<li>` only when it is the innermost element. So the
//   nesting is not ESTIMATED off the string — an estimate of this parser's recovery rules was
//   passed four ways, with pages that then took 7 to 11 s — it is COUNTED by the same parser, with
//   no tree, and stopped the moment it crosses a limit (`withinReadModeMarkup`). Stopped at
//   MAX_READ_MODE_DEPTH, the parser's array never holds more than that, so the count is linear.
// - READABILITY on the parsed tree costs time in the shape, and counts NODES, not elements:
//   linkedom keeps an element's attributes in the same list as its children, and text runs and
//   comments are nodes too, so every subtree walk steps through all of them. In nesting, about
//   nodes x depth^2 (a 74 KB page 250 deep with 5,000 spans took 23.5 s in workerd; 240 nested
//   `<div>`s around one `<p>` with 155,000 attributes, 207 s). In width, a parent's child nodes
//   times its element children: Readability re-reads a parent's `children` after each sibling it
//   appends, and linkedom builds that list afresh each time, stepping over attributes and every
//   other child on the way (59,000 sibling paragraphs: 173 s; 4,900 among 55,000 comments: 17 s).
//   So the walk after the parse weighs both (`withinReadModeBounds`, MAX_READ_MODE_COST) and stops
//   at the cap.
// - READABILITY's REPEATED work, which no prediction from the tree's shape bounds. It copies an
//   element's attributes one by one when it renames it, re-reads an `<embed>`'s attributes under
//   every container above it, re-reads every element's text whole for each element above it, and
//   runs all of it again, up to four times, when the article it finds is short (40,000 attributes
//   on one `<div>`: 135 s; a 19 KB embed under 50 containers that forced every retry: 175 s; one
//   900 KB text run 240 deep: 10.8 s). Each review found another such path the walk couldn't see.
//   So it is COUNTED as it happens: the meter (THE METER, below) wraps the linkedom
//   reads that work goes through and stops the read past MAX_READ_MODE_WORK, and each retry is
//   charged the walk's prediction for one more pass. The rest of what was found slow is work in one
//   string — a regex that retries from every character, every word of a title compared with every
//   word of a heading, a wrapper's attributes copied down a chain — and is made linear instead
//   (`defuseForReadability`, `LinearReadability`).
//
// What the meter doesn't count — the node walks of one pass, the parse, the string work made
// linear — the checks above price or remove; a getter Readability starts using in an upgrade isn't
// counted until it is added. So the Worker's own CPU limit (wrangler.jsonc, `limits.cpu_ms` on
// production) stays the backstop: a request that slipped past them all would die there, as a 5xx.
// Staging, on the Workers Free plan, has Free's own, tighter limit instead.
//
// The caps are a judgement from local pages, not from real traffic. Over 616 local HTML files none
// is refused; the heaviest, a 1 MB export of 10,000 bookmarks (19,000 elements), weighs 3.2e7 of
// the walk's 4e7 and spends 1.1e6 of the meter's 2e7, and took about 0.7 s on Node, 0.9 s in
// workerd. Pages generated to look honest read too: a 1 MB article 40 wrappers deep spends 7e6; up
// to 750 KB a docs page with a large sidebar, a comment thread 30 replies deep and a card grid all
// read, and at 1 MB the sidebar and the thread are refused by the walk. Every page the reviews built
// to be slow, scaled to the largest the walk and the meter accept, took at most 2.4 s in workerd,
// and all but the walk's own flat-sibling shapes under 1.4 s — the shapes found, not a bound. A page
// past a cap is answered `not-an-article`; the live set `measure:kept-copies` fetches would say
// whether a real page is refused, and has not been run against it.
export const MAX_READ_MODE_DEPTH = 256;
export const MAX_READ_MODE_ELEMENTS = 60_000;
export const MAX_READ_MODE_COST = 40_000_000;
// Nodes the parser may emit other than elements before the page is refused: text runs and comments,
// each of which becomes a node linkedom builds and Readability walks — super-linearly when they
// share a parent (240,000 in one `<p>` took 4 s on Node; 60,000, 0.7 s) — and processing
// instructions (a doctype), which linkedom keeps as no node but which cost the parser the same.
// htmlparser2 emits a text run per decoded entity, so a megabyte of `&amp;` is 200,000 of them. The
// heaviest local page has 19,000.
export const MAX_READ_MODE_NODES = 60_000;

// Thrown out of the parser's own callbacks to stop it at the first limit crossed.
class ReadModeLimit extends Error {}

// Is the page inside the limits, as the parser linkedom uses would build it? One pass of
// htmlparser2 with the options linkedom gives it (linkedom/esm/shared/parse-from-string.js),
// building no tree: every element the parser opens is an `onopentagname` and every one it closes,
// stated or implied, an `onclosetag`, so the depth counted here is the depth linkedom's tree will
// have. Run BEFORE `parseHTML`, which is what it protects.
export function withinReadModeMarkup(html: string): boolean {
  let depth = 0;
  let elements = 0;
  let nodes = 0;
  const other = () => {
    if (++nodes > MAX_READ_MODE_NODES) throw new ReadModeLimit();
  };
  const parser = new Parser(
    {
      onopentagname() {
        if (++depth > MAX_READ_MODE_DEPTH || ++elements > MAX_READ_MODE_ELEMENTS) {
          throw new ReadModeLimit();
        }
      },
      onclosetag() {
        depth--;
      },
      ontext: other,
      oncomment: other,
      onprocessinginstruction: other,
    },
    { lowerCaseAttributeNames: false, decodeEntities: true, xmlMode: false },
  );
  try {
    parser.write(html);
    parser.end();
    return true;
  } catch (err) {
    if (err instanceof ReadModeLimit) return false;
    throw err;
  }
}

// Is this parsed document inside those bounds? One iterative walk (no recursion: the page chooses
// the depth), stopping at the first element that crosses one.
//
// The cost weighs NODES, not elements. linkedom keeps an element's attributes in the same linked
// list as its children, and text runs and comments are nodes too, so every subtree walk Readability
// makes steps through all of them: 240 nested `<div>`s around one `<p>` with 5,000 attributes took
// 2.7 s on Node, though its elements cost almost nothing. So each element adds its depth squared
// times (1 + its attributes + its children that are not elements), and each parent adds its element
// children times (all its child nodes + its attributes), the width term Readability's sibling loop
// pays for; and each element ATTRIBUTE_COPY_WEIGHT times its attributes squared, the one copy
// `_setNodeTag` makes when Readability renames it. A PREDICTION of one pass of Readability, refusing
// the shapes that are slow on their own before any of it runs; what Readability repeats — per
// ancestor, per attempt — is counted by the meter as it happens (THE METER, below).
export function withinReadModeBounds(root: WalkedNode): boolean {
  return readModeWalkCost(root) !== null;
}

// The walk's cost, or null past a limit (it stops at the first element that crosses one).
function readModeWalkCost(root: WalkedNode): number | null {
  const stack: { el: WalkedNode; depth: number }[] = [];
  let count = 0;
  let cost = 0;
  // Pushes `parent`'s element children and charges its width; returns how many of its child nodes
  // are not elements, or -1 past a limit.
  const push = (parent: WalkedNode, depth: number, attributes: number): number => {
    let children = 0;
    for (let c = parent.firstElementChild; c; c = c.nextElementSibling) {
      stack.push({ el: c, depth });
      if (++children > MAX_READ_MODE_ELEMENTS) return -1;
    }
    const nodes = parent.childNodes.length;
    cost += children * (nodes + attributes);
    return cost > MAX_READ_MODE_COST ? -1 : nodes - children;
  };
  if (push(root, 1, 0) < 0) return null;
  while (stack.length > 0) {
    const { el, depth } = stack.pop() as { el: WalkedNode; depth: number };
    const attributes = el.attributes?.length ?? 0;
    const other = push(el, depth + 1, attributes);
    if (other < 0) return null;
    cost +=
      depth * depth * (1 + attributes + other) + ATTRIBUTE_COPY_WEIGHT * attributes * attributes;
    if (
      depth > MAX_READ_MODE_DEPTH ||
      ++count > MAX_READ_MODE_ELEMENTS ||
      cost > MAX_READ_MODE_COST
    ) {
      return null;
    }
  }
  return cost;
}

// An attribute pair in Readability's copy loops (`_setNodeTag`: rebuild the list, read one, look the
// name up on the target) against a unit of the walk's: 40,000 attributes on one `<div>`, 1.6e9 pairs,
// took 135 s in workerd, about 84 ns a pair; the walk's heaviest unit is about 60 ns.
const ATTRIBUTE_COPY_WEIGHT = 2;

// What the walk reads of linkedom's document and elements.
type WalkedNode = {
  firstElementChild: WalkedNode | null;
  nextElementSibling: WalkedNode | null;
  childNodes: { length: number };
  attributes?: { length: number };
};

// THE METER. Readability does some of its work again and again — an `<embed>`'s attributes once for
// every container above it (`_cleanConditionally`), an element's text once for every element above
// it, and all of it once per attempt, up to four when the article it finds is short — so no
// prediction from the tree's shape bounds it: each review found another path the walk above could
// not see (a 19 KB page, inside the walk's cap, took 175 s in workerd). So the reads that work goes
// through are COUNTED while Readability and the walker run: every `attributes`, `childNodes` and
// `children` list linkedom builds (it builds each afresh, stepping over the list it returns), every
// `textContent` and `innerHTML` it assembles, every tag query's result — each by its length. Past
// MAX_READ_MODE_WORK the read throws, and the page is `not-an-article`. A clock can't do this: a
// Worker's clock doesn't move during synchronous work.
//
// The getters are linkedom's own, wrapped once on its shared prototypes, and count only while a
// read is metered (`meter` set): Readability runs synchronously, so nothing else runs inside a read.
// A getter Readability starts using in an upgrade is not counted until it is added here.
export const MAX_READ_MODE_WORK = 20_000_000;

class ReadModeOverBudget extends Error {}

let meter: { spent: number; budget: number } | null = null;
let meterInstalled = false;

function spend(units: number): void {
  if (meter === null) return;
  meter.spent += units;
  if (meter.spent > meter.budget) throw new ReadModeOverBudget();
}

const lengthOf = (value: unknown): number =>
  value === null || value === undefined ? 0 : ((value as { length?: number }).length ?? 0);

function ownerOf(target: object, name: string): object {
  let proto: object | null = target;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, name)) {
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  if (!proto) throw new Error(`linkedom has no ${name}`);
  return proto;
}

// What one item of each read costs, in units of about one attribute-list entry (~22 ns on Node):
// measured per getter over the pages that lean on it — an `attributes` entry (an `<embed>`'s, 50
// containers deep: 22 ns), a `children` entry (flat siblings: ~37 ns), a character of `textContent`
// (a 1 MB article 40 deep, a 900 KB text run 240 deep: 0.5–1.2 ns) or of `innerHTML`, serialised
// node by node. So the items of a read are weighted to time, and a page can't buy a cheap unit.
const READ_WEIGHTS: Record<string, number> = {
  attributes: 1,
  childNodes: 2,
  children: 2,
  textContent: 1 / 32,
  innerHTML: 1 / 8,
  getElementsByTagName: 1,
  querySelectorAll: 1,
};

function meterGetter(target: object, name: string): void {
  const proto = ownerOf(target, name);
  const descriptor = Object.getOwnPropertyDescriptor(proto, name) as PropertyDescriptor;
  const get = descriptor.get as (this: unknown) => unknown;
  const weight = READ_WEIGHTS[name];
  Object.defineProperty(proto, name, {
    ...descriptor,
    get(this: unknown) {
      const value = get.call(this);
      spend(1 + lengthOf(value) * weight);
      return value;
    },
  });
}

function meterMethod(target: object, name: string): void {
  const proto = ownerOf(target, name) as Record<string, (...args: unknown[]) => unknown>;
  const method = proto[name];
  const weight = READ_WEIGHTS[name];
  proto[name] = function (this: unknown, ...args: unknown[]) {
    const value = method.apply(this, args);
    spend(1 + lengthOf(value) * weight);
    return value;
  };
}

function installMeter(document: ParsedDocument): void {
  if (meterInstalled) return;
  meterInstalled = true;
  const element = document.createElement('div');
  for (const name of ['attributes', 'textContent', 'innerHTML', 'childNodes', 'children']) {
    meterGetter(element, name);
  }
  for (const name of ['getElementsByTagName', 'querySelectorAll']) meterMethod(element, name);
  // The document's own `querySelectorAll`; its `getElementsByTagName` is the element's.
  if (ownerOf(document, 'querySelectorAll') !== ownerOf(element, 'querySelectorAll')) {
    meterMethod(document, 'querySelectorAll');
  }
}

// Runs `read` with the meter on; the units it spent, and what it returned (undefined past `budget`).
function metered<T>(budget: number, read: () => T): { spent: number; value: T | undefined } {
  const session = { spent: 0, budget };
  meter = session;
  try {
    const value = read();
    return { spent: session.spent, value };
  } catch (err) {
    if (err instanceof ReadModeOverBudget) return { spent: session.spent, value: undefined };
    throw err;
  } finally {
    meter = null;
  }
}

export function readModeFromHtml(
  html: string,
  finalUrl: URL,
  now = Date.now(),
): { doc: ReaderDoc; images: ReaderImageSource[] } | null {
  try {
    return readModeOrThrow(html, finalUrl, now, MAX_READ_MODE_WORK).value ?? null;
  } catch {
    return null;
  }
}

// The work a page asks of read mode, in the meter's units — for calibration and specs. Stops once
// past `budget`, so a figure over it means "at least". Null when the page is refused before
// Readability runs.
export function readModeWork(html: string, finalUrl: URL, budget = Infinity): number | null {
  try {
    return readModeOrThrow(html, finalUrl, Date.now(), budget).spent;
  } catch {
    return null;
  }
}

type ReadModeResult = { doc: ReaderDoc; images: ReaderImageSource[] } | null;

function readModeOrThrow(
  html: string,
  finalUrl: URL,
  now: number,
  budget: number,
): { spent: number | null; value: ReadModeResult | undefined } {
  // Before the parse, which is what nesting can make slow (above) ...
  if (!withinReadModeMarkup(html)) return { spent: null, value: null };
  const { document } = parseHTML(html);
  // ... and before anything walks the tree: Readability's cost is not bounded by the bytes.
  const passCost = readModeWalkCost(document as unknown as WalkedNode);
  if (passCost === null) return { spent: null, value: null };
  setBaseUrl(document, finalUrl);
  defuseForReadability(document);
  installMeter(document);

  // ... and Readability, the second parse and the walker under the meter (above).
  return metered(budget, (): ReadModeResult => {
    const page = document as unknown as ReadabilityDocument;
    if (!isProbablyReaderable(page)) return null;
    // No clone, unlike the live-page capture: this document is ours, built for this one
    // read, and nothing else looks at it after Readability has mutated it.
    const article = new LinearReadability(page, passCost).parse();
    if (!article?.content) return null;

    const parsed = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
    return readerCaptureFromArticle(
      parsed.document.body as unknown as DomNode,
      article,
      finalUrl.toString(),
      now,
    );
  });
}

// Readability with two of its own methods made linear. Both are Readability's internals, not its
// API, so a spec fails if an upgrade stops having them.
//
// - `_textSimilarity` checks each word of one text against every word of the other
//   (`Array.includes`), and it compares the article title with every `<h1>` and `<h2>`: a 960 KB
//   `og:title` against an `<h2>` of other words took 55 s. The same answer from a Set, with the
//   title's words kept between calls.
// - `_simplifyNestedElements` replaces a `<div>` or `<section>` that only wraps another with that
//   child, copying the wrapper's attributes onto it one by one (each copy rebuilds linkedom's list),
//   and goes on down: a chain carries every wrapper's attributes above it, each level paying their
//   count squared (276 wrappers of 250 attributes over 20-deep chains: 32 s). Nothing after it reads
//   a wrapper's attributes — Readability only strips classes, and the walker reads links, images and
//   table cells — so they are removed first, each in one step, and the chain has none to carry.
//   (That includes the id of Readability's own `readability-page-1` wrapper, which the method spares;
//   simplified, it leaves the same text.)
export class LinearReadability extends Readability {
  // What one more pass of the page costs, in the meter's units: the walk's own prediction
  // (withinReadModeBounds), which has already admitted ONE pass.
  constructor(
    document: ReadabilityDocument,
    private readonly passCost: number,
  ) {
    super(document);
  }

  private similarityText?: string;
  private similarityWords = new Set<string>();

  _textSimilarity(textA: string, textB: string): number {
    if (textA !== this.similarityText) {
      this.similarityText = textA;
      this.similarityWords = new Set(words(textA));
    }
    return similarity(this.similarityWords, words(textB));
  }

  // Readability's retry: when the article it found is under 500 characters it drops a flag and runs
  // the whole of `_grabArticle` again, up to three more times, and this is the one place it does.
  // The node walks of each extra pass are what the walk check predicted for one; the meter counts
  // the reads, not the walks, so each retry is charged the prediction (a page that passed the walk
  // at its cap and forced every retry would otherwise run four passes).
  _removeFlag(flag: number): void {
    spend(this.passCost);
    readabilityMethod('_removeFlag').call(this, flag);
  }

  _simplifyNestedElements(articleContent: DefusedElement): void {
    const wrappers = articleContent.querySelectorAll('div, section') as ArrayLike<DefusedElement>;
    for (const wrapper of [articleContent, ...Array.from(wrappers)]) {
      for (const { name } of Array.from(wrapper.attributes)) wrapper.removeAttribute(name);
    }
    readabilityMethod('_simplifyNestedElements').call(this, articleContent);
  }
}

// One of Readability's own methods, by name, for an override to call through to.
export function readabilityMethod(name: string): (this: unknown, ...args: unknown[]) => unknown {
  return (Readability.prototype as unknown as Record<string, never>)[name];
}

const words = (text: string) => text.toLowerCase().split(/\W+/).filter(Boolean);

// Readability's `_textSimilarity`, with `tokensA.includes` replaced by a Set lookup.
export function textSimilarity(textA: string, textB: string): number {
  return similarity(new Set(words(textA)), words(textB));
}

function similarity(wordsA: Set<string>, wordsB: string[]): number {
  if (wordsA.size === 0 || wordsB.length === 0) return 0;
  const unique = wordsB.filter((word) => !wordsA.has(word));
  return 1 - unique.join(' ').length / wordsB.join(' ').length;
}

// The strings Readability runs a backtracking regex over, made safe before it runs, with the
// answer each regex would give unchanged where it can be and the attribute dropped where not:
//
// - `<meta property>`: Readability matches `/\s*(article|…)\s*:…/g`, unanchored, so a long run of
//   whitespace costs its length squared. Each run becomes one space, which every `\s*` in it
//   matches the same way, and Readability strips the whitespace from what it keeps anyway.
// - `srcset`, and an image's lazy-loading attribute that Readability would copy into one: its
//   `srcsetUrl` regex retries from every character of a run whose end it can't match (81 KB: 24 s).
//   `srcsetBacktracks` follows the regex's own scan and says whether it reaches such a run; an
//   honest srcset never does, and an image without one keeps its `src`.
// - Another lazy-loading attribute: `/^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/` tries every extension
//   in the first word of a value of several words, each to the end of that word.
export function defuseForReadability(document: ParsedDocument): void {
  const all = (selector: string) =>
    Array.from(document.querySelectorAll(selector) as ArrayLike<DefusedElement>);
  for (const meta of all('meta[property]')) {
    const property = meta.getAttribute('property') ?? '';
    const collapsed = property.replace(/\s+/g, ' ');
    if (collapsed !== property) meta.setAttribute('property', collapsed);
  }
  for (const media of all(MEDIA)) {
    const lazy = LAZY_IMAGE.has(media.tagName);
    for (const { name, value } of Array.from(media.attributes)) {
      if (name === 'src' || name === 'alt') continue;
      const copiedAsSrcset = name === 'srcset' || (lazy && LAZY_SRCSET.test(value));
      if (copiedAsSrcset ? srcsetBacktracks(value) : lazy && lazySrcBacktracks(value)) {
        media.removeAttribute(name);
      }
    }
  }
}

// What the pass reads and writes of linkedom's elements.
type DefusedElement = {
  tagName: string;
  querySelectorAll(selector: string): unknown;
  attributes: ArrayLike<{ name: string; value: string }>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};
const MEDIA = 'img, picture, figure, video, audio, source';
// The elements `_fixLazyImages` reads attributes of, and its two tests on each value.
const LAZY_IMAGE = new Set(['IMG', 'PICTURE', 'FIGURE']);
const LAZY_SRCSET = /\.(jpg|jpeg|png|webp)\s+\d/;
const LAZY_SRC_EXTENSION = /\.(jpg|jpeg|png|webp)/g;
const LAZY_SRC_MAX_EXTENSIONS = 8;

// Does Readability's `/(\S+)(\s+[\d.]+[xw])?(\s*(?:,|$))/g` meet a run it retries from every
// character? Its scan, run once: from each run of non-space, the match takes the whole run when what
// follows it matches the tail, and the regex goes on after the tail. When the tail fails, the match
// backs off to the run's last comma (`a.jpg, b.jpg` ends its first run in one), and every start
// after that comma fails, each reading to the run's end — so it is a retried run unless that comma
// ends the run.
export function srcsetBacktracks(srcset: string): boolean {
  const tail = /(?:\s+[\d.]+[xw])?\s*(?:,|$)/y;
  let at = 0;
  while (at < srcset.length) {
    while (at < srcset.length && /\s/.test(srcset[at])) at++;
    if (at >= srcset.length) return false;
    let end = at;
    while (end < srcset.length && !/\s/.test(srcset[end])) end++;
    tail.lastIndex = end;
    const match = tail.exec(srcset);
    if (match) at = end + match[0].length;
    else if (end - 1 > at && srcset[end - 1] === ',') at = end;
    else return true;
  }
  return false;
}

// `/^\s*\S+\.(jpg|jpeg|png|webp)\S*\s*$/` can only fail when the value is more than one word, and
// then it tries each extension in the first word to that word's end.
function lazySrcBacktracks(value: string): boolean {
  const trimmed = value.trim();
  const space = trimmed.search(/\s/);
  if (space < 0) return false;
  const first = trimmed.slice(0, space);
  return (first.match(LAZY_SRC_EXTENSION)?.length ?? 0) > LAZY_SRC_MAX_EXTENSIONS;
}

// The bytes of an HTML response as text, in the charset the response names — the
// `content-type` parameter, else a `<meta charset>` (or its http-equiv spelling) in the
// first KB, as a browser sniffs — and UTF-8 when it names none this runtime decodes.
// `fatal: false` throughout: a stray bad byte is a replacement character, never a throw.
export function decodeHtml(bytes: Uint8Array, contentTypeHeader: string | null): string {
  const label = charsetFromHeader(contentTypeHeader) ?? charsetFromMeta(bytes);
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // a label this runtime doesn't know — fall through to UTF-8
    }
  }
  return new TextDecoder().decode(bytes);
}

function charsetFromHeader(header: string | null): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(header ?? '');
  return match?.[1];
}

function charsetFromMeta(bytes: Uint8Array): string | undefined {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const match =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i.exec(head);
  return match?.[1];
}
