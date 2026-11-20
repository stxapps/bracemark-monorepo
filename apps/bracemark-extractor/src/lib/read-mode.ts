import { isProbablyReaderable } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import { declaredCharset, type ReaderDoc, type ReaderImageSource } from '@stxapps/shared';
import { type DomNode, readerCaptureFromArticle } from '@stxapps/shared/reader/reader-doc-from-dom';

import { readModeWalkCost, type WalkedNode, withinReadModeMarkup } from './read-mode-limits';
import { installMeter, MAX_READ_MODE_WORK, metered } from './read-mode-meter';
import {
  defuseForReadability,
  LinearReadability,
  type ReadabilityDocument,
} from './read-mode-readability';

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
//
// The pipeline is here; its three guards each have a module: read-mode-limits.ts (before the parse
// and before Readability), read-mode-meter.ts (while Readability runs), read-mode-readability.ts
// (Readability's own slow paths, made linear).

type ParsedDocument = ReturnType<typeof parseHTML>['document'];

export type ReadModeCapture = { doc: ReaderDoc; images: ReaderImageSource[] };

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
export function readModeFromHtml(
  html: string,
  finalUrl: URL,
  now = Date.now(),
): ReadModeCapture | null {
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

// The read, in order, with a guard before each cost a page can make unbounded. Past any of them the
// page is "not an article". The byte cap (MAX_HTML_BYTES) bounds what is READ, not what it COSTS, and
// a stranger picks the page. Three costs:
//
// - PARSING (linkedom's `parseHTML`, which is htmlparser2 underneath) costs time in the square of
//   the nesting: htmlparser2 keeps its open elements in an array it `unshift`s and searches, so
//   160,000 nested `<div>`s (950 KB) took 24 s. A page can nest that deep without writing a single
//   `<div>`: htmlparser2 ignores `/>` on an element that isn't void, leaves `<thead>` and
//   `<colgroup>` open, and closes a `<p>` or `<li>` only when it is the innermost element. So the
//   nesting is not ESTIMATED off the string — an estimate of this parser's recovery rules was
//   passed four ways, with pages that then took 7 to 11 s — it is COUNTED by the same parser, with
//   no tree, and stopped the moment it crosses a limit (`withinReadModeMarkup`, read-mode-limits.ts).
//   Stopped at MAX_READ_MODE_DEPTH, the parser's array never holds more than that, so the count is
//   linear.
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
//   So it is COUNTED as it happens: the meter (read-mode-meter.ts) wraps the linkedom
//   reads that work goes through and stops the read past MAX_READ_MODE_WORK, and each retry is
//   charged the walk's prediction for one more pass. The rest of what was found slow is work in one
//   string — a regex that retries from every character, every word of a title compared with every
//   word of a heading, a wrapper's attributes copied down a chain — and is made linear instead
//   (read-mode-readability.ts).
//
// What the meter doesn't count — the node walks of one pass, the parse, the string work made
// linear — the checks above price or remove; a getter Readability starts using in an upgrade isn't
// counted until it is added. So the Worker's own CPU limit (wrangler.jsonc, `limits.cpu_ms` on
// production) stays the backstop: a request that slipped past them all would die there, as a 5xx.
// Staging, on the Workers Free plan, can't set one, and Free's documented 10 ms has been seen
// going unenforced (e2e/STAGING.md), so there the checks are the only bound.
//
// The caps are a judgement from local pages, not from real traffic. Over 616 local HTML files none
// is refused; the heaviest, a 1 MB export of 10,000 bookmarks (19,000 elements), weighs 3.2e7 of
// the walk's 4e7 and spends 1.1e6 of the meter's 2e7, and took about 0.7 s on Node, 0.9 s in
// workerd. Pages generated to look honest read too: a 1 MB article 40 wrappers deep spends 7e6; up
// to 750 KB a docs page with a large sidebar, a comment thread 30 replies deep and a card grid all
// read, and at 1 MB the sidebar and the thread are refused by the walk. Every page the reviews built
// to be slow, scaled to the largest the walk and the meter accept, took at most about 2.5 s in workerd,
// and all but the walk's own flat-sibling shapes under 1.4 s — the shapes found, not a bound. A page
// past a cap is answered `not-an-article`. So are some honest pages: a few thousand sibling
// paragraphs (docs/link-extraction-server.md, _cost on the Worker_). Over 52 real pages
// (`measure:server-read-mode`, 2026-11-18) none is refused, and none comes within a quarter of a cap.
function readModeOrThrow(
  html: string,
  finalUrl: URL,
  now: number,
  budget: number,
): { spent: number | null; value: ReadModeCapture | null | undefined } {
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
  return metered(budget, (): ReadModeCapture | null => {
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

// The bytes of an HTML response as text, in the charset the response names — the
// `content-type` parameter, else a `<meta charset>` (or its http-equiv spelling) in the
// first KB, as a browser sniffs; that sniff is `@stxapps/shared`'s `declaredCharset`
// (html/charset.ts), shared with bracemark-expo's head scanner — and UTF-8 when it names
// none this runtime decodes. workerd's `TextDecoder` knows every WHATWG label, which is
// why this decode stays here and not beside the sniff: Hermes's knows only UTF-8.
// `fatal: false` throughout: a stray bad byte is a replacement character, never a throw.
export function decodeHtml(bytes: Uint8Array, contentTypeHeader: string | null): string {
  const label = declaredCharset(bytes, contentTypeHeader);
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // a label this runtime doesn't know — fall through to UTF-8
    }
  }
  return new TextDecoder().decode(bytes);
}
