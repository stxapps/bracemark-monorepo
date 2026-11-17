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
// (MAX_HTML_BYTES) bounds what is READ, not what it COSTS, and a stranger picks the page. Two
// costs, so two checks:
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
// - READABILITY on the parsed tree costs time in the shape: about elements x depth^2 for nesting (a
//   74 KB page 250 deep with 5,000 spans took 23.5 s), and the square of an element's child count
//   for width — it re-reads a parent's `children` after each sibling it appends, and linkedom
//   builds that list afresh each time (59,000 sibling paragraphs took 173 s in workerd). So the
//   walk after the parse adds up depth^2 for every element and children^2 for every parent
//   (MAX_READ_MODE_COST), and stops at the cap.
//
// These price the shapes found, not every shape a page could pick — Readability is a heuristic, not
// a bounded algorithm — so the Worker's own CPU limit (wrangler.jsonc, `limits.cpu_ms` on
// production) is the backstop: a page that slips past both dies there, as a 5xx.
//
// The cap is a judgement from local pages, not from real traffic. The heaviest local document, a
// 1.1 MB list of 22,000 elements, adds up to about 1.3e7; real article pages sit one to three orders
// of magnitude under it. At 2.5e7 the slowest shape found took about 2 s on Node. A page past it is
// answered `not-an-article`; the live set `measure:kept-copies` fetches would say whether a real
// page is refused, and has not been run against it.
export const MAX_READ_MODE_DEPTH = 256;
export const MAX_READ_MODE_ELEMENTS = 60_000;
export const MAX_READ_MODE_COST = 25_000_000;
// Nodes the parser may emit other than elements before the page is refused: comments, text runs and
// processing instructions, each of which becomes a node linkedom builds and Readability walks — and
// walks super-linearly when they share a parent (240,000 in one `<p>` took 4 s on Node; 60,000,
// 0.7 s). htmlparser2 emits a text run per decoded entity, so a megabyte of `&amp;` is 200,000 of
// them. The heaviest local page has 19,000.
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
// the depth), stopping at the first element that crosses one. Each element adds its depth squared,
// and each element with children adds their count squared (the root's included).
export function withinReadModeBounds(root: { firstElementChild: unknown }): boolean {
  type El = { firstElementChild: El | null; nextElementSibling: El | null };
  const stack: { el: El; depth: number }[] = [];
  let count = 0;
  let cost = 0;
  const push = (parent: { firstElementChild: unknown }, depth: number): boolean => {
    let children = 0;
    for (let c = parent.firstElementChild as El | null; c; c = c.nextElementSibling) {
      stack.push({ el: c, depth });
      if (++children > MAX_READ_MODE_ELEMENTS) return false;
    }
    cost += children * children;
    return cost <= MAX_READ_MODE_COST;
  };
  if (!push(root, 1)) return false;
  while (stack.length > 0) {
    const { el, depth } = stack.pop() as { el: El; depth: number };
    cost += depth * depth;
    if (
      depth > MAX_READ_MODE_DEPTH ||
      ++count > MAX_READ_MODE_ELEMENTS ||
      cost > MAX_READ_MODE_COST ||
      !push(el, depth + 1)
    ) {
      return false;
    }
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
