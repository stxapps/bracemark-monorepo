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
// `images` is the address of every figure the document gave a key to — the client's to
// fetch through the image proxy (routes/image.ts), never this Worker's: fetching thirty
// images inside the extract request would hold it open past its deadline and inline
// megabytes into a JSON response. The walker has resolved each against the final URL.
export function readModeFromHtml(
  html: string,
  finalUrl: URL,
  now = Date.now(),
): { doc: ReaderDoc; images: ReaderImageSource[] } | null {
  const { document } = parseHTML(html);
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
