import { isProbablyReaderable, Readability } from '@mozilla/readability';
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
// The most work a page may ask of the parse before it is called "not an article". The byte cap
// (MAX_HTML_BYTES) bounds what is READ, not what it COSTS, and a stranger picks the page. Two
// costs, so two checks:
//
// - PARSING (linkedom's `parseHTML`) is cheap until the nesting is absurd: a page of 1,000 or
//   10,000 nested `<div>`s parses in milliseconds, 160,000 of them (950 KB) in 24 s. It runs before
//   any walk can look at the tree, so it is bounded on the STRING: `withinReadModeMarkup`.
// - READABILITY on the parsed tree is super-linear in nesting and depends on the page's shape. It
//   was measured at about elements x depth^2 (a 74 KB page 250 deep with 5,000 spans took 23.5 s),
//   and the same size and depth with a different article took 0.4 s, so a count of elements and a
//   depth limit alone bound nothing. The walk adds up depth^2 over every element
//   (MAX_READ_MODE_COST) and stops at the cap.
//
// The cap is a judgement from local pages, not from real traffic. The heaviest local document, a
// 1.1 MB list of 22,000 elements, adds up to 1.3e7; real article pages sit one to three orders of
// magnitude under it (median 3e3, p99 1.3e6). At 2.5e7 the slowest page shape found took about 2 s
// on Node. A page past it is answered `not-an-article`; the live set `measure:kept-copies` fetches
// would say whether a real page is refused, and has not been run against it.
export const MAX_READ_MODE_DEPTH = 256;
export const MAX_READ_MODE_ELEMENTS = 60_000;
export const MAX_READ_MODE_COST = 25_000_000;
// Markup the string may hold before it is parsed: `<` characters (tags, comments, and any `<` in
// text or script), and the nesting its tags add up to with the implied closes left out. Both are
// loose on purpose — an estimate off a string, never the document's truth — and sit well over a
// real page (the local maximum is 32,000 `<` and a depth of 36).
export const MAX_READ_MODE_MARKUP = 150_000;
export const MAX_READ_MODE_NESTING_ESTIMATE = 4 * MAX_READ_MODE_DEPTH;

// Elements that never hold children, and elements whose end tag HTML lets a page leave out (so an
// open one is not an open level). Everything else counts as opening a level until its end tag.
const NON_NESTING = new Set(
  (
    'area base br col embed hr img input link meta param source track wbr ' +
    'p li dt dd tr td th thead tbody tfoot option optgroup colgroup rt rp'
  ).split(' '),
);

// Is the string inside the markup bounds? One linear pass, no tree: every index it asks for only
// moves forward (a regex that backtracked to each `<` for a `>` that never comes would not be
// linear). Cheap — a 1 MB page is a few milliseconds — and run BEFORE `parseHTML`, which is what
// it protects. It reads names and the `/` before a `>` only; a `>` inside an attribute value ends
// a tag early, which an estimate can afford.
export function withinReadModeMarkup(html: string): boolean {
  let tags = 0;
  let depth = 0;
  let close = html.indexOf('>');
  for (let at = html.indexOf('<'); at !== -1; at = html.indexOf('<', at + 1)) {
    if (++tags > MAX_READ_MODE_MARKUP) return false;
    const closing = html.charCodeAt(at + 1) === 47; // '/'
    let end = at + (closing ? 2 : 1);
    while (end < html.length && isNameChar(html.charCodeAt(end), end === at + (closing ? 2 : 1))) {
      end++;
    }
    if (end === at + (closing ? 2 : 1)) continue; // `<!--`, `<!doctype`, `<?`, a stray `<`
    if (close !== -1 && close < end) close = html.indexOf('>', end);
    if (NON_NESTING.has(html.slice(at + (closing ? 2 : 1), end).toLowerCase())) continue;
    if (!closing && close !== -1 && html.charCodeAt(close - 1) === 47) continue; // `<x />`
    if (closing) depth = Math.max(0, depth - 1);
    else if (++depth > MAX_READ_MODE_NESTING_ESTIMATE) return false;
  }
  return true;
}

// A tag name's characters: a letter first, then letters, digits and `-`.
function isNameChar(code: number, first: boolean): boolean {
  const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  return first ? letter : letter || (code >= 48 && code <= 57) || code === 45;
}

// Is this parsed document inside those bounds? One iterative walk (no recursion: the page chooses
// the depth), stopping at the first element that crosses one.
export function withinReadModeBounds(root: { firstElementChild: unknown }): boolean {
  type El = { firstElementChild: El | null; nextElementSibling: El | null };
  const stack: { el: El; depth: number }[] = [];
  const push = (parent: { firstElementChild: unknown }, depth: number) => {
    for (let c = parent.firstElementChild as El | null; c; c = c.nextElementSibling) {
      stack.push({ el: c, depth });
    }
  };
  push(root, 1);
  let count = 0;
  let cost = 0;
  while (stack.length > 0) {
    const { el, depth } = stack.pop() as { el: El; depth: number };
    cost += depth * depth;
    if (
      depth > MAX_READ_MODE_DEPTH ||
      ++count > MAX_READ_MODE_ELEMENTS ||
      cost > MAX_READ_MODE_COST
    ) {
      return false;
    }
    push(el, depth + 1);
  }
  return true;
}

export function readModeFromHtml(
  html: string,
  finalUrl: URL,
  now = Date.now(),
): { doc: ReaderDoc; images: ReaderImageSource[] } | null {
  try {
    return readModeOrThrow(html, finalUrl, now);
  } catch {
    return null;
  }
}

function readModeOrThrow(
  html: string,
  finalUrl: URL,
  now: number,
): { doc: ReaderDoc; images: ReaderImageSource[] } | null {
  // Before the parse, which is what nesting can make slow (above) ...
  if (!withinReadModeMarkup(html)) return null;
  const { document } = parseHTML(html);
  // ... and before anything walks the tree: Readability's cost is not bounded by the bytes.
  if (!withinReadModeBounds(document as unknown as { firstElementChild: unknown })) return null;
  setBaseUrl(document, finalUrl);

  const page = document as unknown as ReadabilityDocument;
  if (!isProbablyReaderable(page)) return null;
  // No clone, unlike the live-page capture: this document is ours, built for this one
  // read, and nothing else looks at it after Readability has mutated it.
  const article = new Readability(page).parse();
  if (!article?.content) return null;

  const parsed = parseHTML(`<!doctype html><html><body>${article.content}</body></html>`);
  return readerCaptureFromArticle(
    parsed.document.body as unknown as DomNode,
    article,
    finalUrl.toString(),
    now,
  );
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
