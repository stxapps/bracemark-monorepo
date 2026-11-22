import type { CollectedMeta } from '../extract/select';
import { decodeHtmlEntities } from './entities';

// Collect a page's title/image/icon CANDIDATES out of its raw HTML, by a linear regex
// scanner — for the runtimes that have markup and no parser for it. It fills the same
// `CollectedMeta` bag as bracemark-extractor's `HTMLRewriter` pass (lib/html.ts) and the
// live-DOM collector (web-react lib/page-meta.ts), and WHICH candidate wins is decided by
// the shared `selectTitleImage`/`selectFaviconUrl` (extract/select.ts), so no two tiers
// disagree about what "the page's title" means — the property that makes a tier upgrade
// an improvement rather than a change. docs/link-extraction.md, _three collectors_.
//
// Two callers:
//   - expo-react lib/parse-html-head.ts, over the HTML the app fetches natively for a
//     preview — Hermes has no DOM (`DOMParser`, `HTMLRewriter` — neither exists there);
//   - web-react lib/page-meta.ts, INSIDE a page whose head went stale after an in-page
//     move, over that page's own address fetched again. A page has a DOM, but not one
//     a string may be parsed into: m.youtube.com enforces Trusted Types, so
//     `DOMParser.parseFromString` throws there. That is why this file is in `shared`,
//     DOM-free, and imports nothing but by relative path — it is bundled into scripts
//     that run inside a stranger's page (zod must not come with it).
//
// WHY A SCANNER AND NOT A PARSER DEPENDENCY. We need five tag shapes — `<title>`,
// `<meta>`, `<link rel=icon|image_src>` — from bounded, already-fetched text, with no
// tree, no scripts and no error recovery to speak of. A dependency would buy
// correctness we can't use and ship a parser into the app bundle for it, so: a scanner,
// kept honest by fixtures (expo-react parse-html-head.spec.ts, scan-meta.spec.ts). The
// pieces below are the malformed-input hazards that actually bite in the wild —
// comments and inline scripts containing tag-like text, single/unquoted attributes —
// not a general-purpose HTML implementation. The other thing a real parser does for
// free, resolving character references, is `decodeHtmlEntities` (entities.ts), shared
// with bracemark-extractor because `HTMLRewriter` doesn't decode either; every value
// collected here goes through it, since the DOM the extension reads would have.

// One tag's attributes as a lowercase-keyed map. Handles double-quoted, single-quoted
// and bare values — all three appear in the wild, and a missed `content` is a missed
// og:title.
//
// The value is OPTIONAL in the pattern so that a name with no `=` (`crossorigin`,
// `async`, or a hostile page's 100 KB of letters) is consumed as a match and skipped.
// Required, a failed `=` backtracks through the whole name and then retries from its
// second letter, its third…: quadratic in the name's length on every engine.
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-z_:][-a-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    const value = m[2] ?? m[3] ?? m[4];
    if (value !== undefined) attrs[m[1].toLowerCase()] = decodeHtmlEntities(value);
  }
  return attrs;
}

// WHY THE SCAN BELOW IS HAND-ROLLED. Every construct it reads — a comment, a
// script/style body, a `<title>`, a `<meta …>` — is an opener followed by a closer,
// and the obvious regex for one (`/<meta\b[^>]*>/g`, `/<!--.*?-->/gs`) is quadratic
// when an opener never closes: the engine scans to the end, fails, and starts over
// from the NEXT opener, which fails the same way. The fact a regex can't use is that
// a closer missing after one opener is missing after every later one — so these
// helpers find the opener by regex, its end by searching forward from it, and stop
// at the first miss. Each character is then scanned about once. Nothing a real page
// does trips the regex version; a hostile one did, on every engine — `<meta ` ×
// 32,000 (156 KB) held Hermes for 24 s. docs/link-extraction.md, _three collectors_.
//
// ⚠ Where a body IS matched by regex, it is `.*?` + `s`, never `[\s\S]*?`: on Hermes
// the class spelling costs time in proportion to the rest of the input on every
// match (`@stxapps/shared` import/netscape.ts). The `REGEX_SYNTAX` lint rule holds it.

// The next tag `open` finds at or after `from` (`open` must be global): where it
// starts, its attribute text, and the index just past its `>`. Undefined at the end,
// or at the first opener with no `>` after it — no later one has one either.
function nextTag(
  text: string,
  open: RegExp,
  from: number,
): { start: number; attrs: string; end: number } | undefined {
  open.lastIndex = from;
  const opener = open.exec(text);
  if (opener === null) return undefined;
  const attrsStart = opener.index + opener[0].length;
  const gt = text.indexOf('>', attrsStart);
  if (gt === -1) return undefined;
  return { start: opener.index, attrs: text.slice(attrsStart, gt), end: gt + 1 };
}

// The next `open … close` span at or after `from` (both global; `openIsTag` when the
// opener runs on to a `>`, as `<script …>` does and `<!--` doesn't): where it starts,
// its body, and the index just past the closer. Undefined when there's no complete one.
function nextSpan(
  text: string,
  open: RegExp,
  close: RegExp,
  openIsTag: boolean,
  from: number,
): { start: number; body: string; end: number } | undefined {
  let start: number;
  let bodyStart: number;
  if (openIsTag) {
    const tag = nextTag(text, open, from);
    if (tag === undefined) return undefined;
    ({ start, end: bodyStart } = tag);
  } else {
    open.lastIndex = from;
    const opener = open.exec(text);
    if (opener === null) return undefined;
    start = opener.index;
    bodyStart = opener.index + opener[0].length;
  }
  close.lastIndex = bodyStart;
  const closer = close.exec(text);
  if (closer === null) return undefined;
  return {
    start,
    body: text.slice(bodyStart, closer.index),
    end: closer.index + closer[0].length,
  };
}

// The scan's text: the capped input with every comment and inline script/style body
// replaced by a space, and where `</head>` closes in what is left (-1 when it never
// does). Both routinely contain tag-like text — a commented-out `<meta
// property="og:image">` left by a CMS, a JS string containing `<title>` or `</head>` —
// and a scanner that doesn't skip them will happily collect it as if the page had
// declared it.
//
// ONE WALK, IN DOCUMENT ORDER, so it can stop at the head's end: `stopAtHeadEnd` returns
// at the first `</head>` outside a span, and the page's body is never looked at. That
// is what lets MAX_HEAD_CHARS (expo-react parse-html-head.ts) be large enough for
// YouTube without making every other page pay for it: a 2 MB Wikipedia article whose
// head closes at 16 KB costs 16 KB. Whichever span opens first is skipped whole, as HTML
// does it (a `<!--` inside a script is script). An opener with no closer — and so no
// later opener of its kind either — turns that kind off and is left in place with all
// that follows it, so a page that never closes a comment keeps its later metadata (the
// scanner's choice, not HTML's), while its scripts are still skipped.
//
// Linear, like the rest: each kind's next opener is found by a regex from the walk's
// position and kept until the walk passes it, so no stretch of text is searched twice
// for the same opener; a span's closer is searched once and the walk jumps past it; a
// closer that is missing is missing for every later opener of its kind, so the kind is
// dropped after the first miss.
function strippedOf(
  html: string,
  maxChars: number,
  stopAtHeadEnd: boolean,
): { text: string; headEnd: number } {
  const text = html.length > maxChars ? html.slice(0, maxChars) : html;
  const kinds = [
    { open: /<!--/g, close: /-->/g, isTag: false, at: -1 },
    { open: /<script\b/gi, close: /<\/script\s*>/gi, isTag: true, at: -1 },
    { open: /<style\b/gi, close: /<\/style\s*>/gi, isTag: true, at: -1 },
  ];
  const headClose = /<\/head\s*>/gi;
  const find = (re: RegExp, from: number): number => {
    re.lastIndex = from;
    return re.exec(text)?.index ?? -1;
  };
  for (const kind of kinds) kind.at = find(kind.open, 0);
  let headAt = find(headClose, 0);

  const kept: string[] = [];
  let keptLength = 0;
  let headEnd = -1;
  let pos = 0;
  const keep = (piece: string) => {
    kept.push(piece);
    keptLength += piece.length;
  };

  for (;;) {
    // The next opener of any kind still live, at or after the walk.
    let next: (typeof kinds)[number] | undefined;
    for (const kind of kinds) {
      if (kind.at !== -1 && kind.at < pos) kind.at = find(kind.open, pos);
      if (kind.at !== -1 && (next === undefined || kind.at < next.at)) next = kind;
    }
    if (headEnd === -1 && headAt !== -1 && headAt < pos) headAt = find(headClose, pos);

    // The head closes before the next span opens: here, in the kept text.
    if (headEnd === -1 && headAt !== -1 && (next === undefined || headAt < next.at)) {
      headEnd = keptLength + (headAt - pos);
      if (stopAtHeadEnd) {
        keep(text.slice(pos, headAt));
        return { text: kept.join(''), headEnd };
      }
    }
    if (next === undefined) break;

    const span = nextSpan(text, next.open, next.close, next.isTag, next.at);
    if (span === undefined) {
      next.at = -1; // unclosed: this kind is over, and its opener stays as text
      continue;
    }
    keep(text.slice(pos, span.start));
    keep(' ');
    pos = span.end;
  }

  keep(text.slice(pos));
  return { text: kept.join(''), headEnd };
}

// Every `<name …>` tag's attribute text, in document order.
function tagAttrs(text: string, open: RegExp): string[] {
  const found: string[] = [];
  for (let tag = nextTag(text, open, 0); tag !== undefined; tag = nextTag(text, open, tag.end)) {
    found.push(tag.attrs);
  }
  return found;
}

export interface ScanHtmlMetaOptions {
  // How much of the input is looked at — the cap on the SCAN, so a pathological body
  // costs bounded regex work whatever the fetcher let through.
  maxChars: number;
  // Where `<meta>` and `<link>` tags are looked for. `head` stops at `</head>` and never
  // looks at the body, whatever `maxChars` allows — the device preview fetch's first
  // read (expo-react parse-html-head.ts), where everything wanted is normally there.
  // `document` reads on past it, as the live DOM's
  // `querySelectorAll('meta')` does — the in-page re-read of a page's own address
  // (web-react page-meta.ts), which must mean what the live collector would have:
  // m.youtube.com, for one, closes its head after 5 KB and declares og:title
  // ~575 KB later, in the body. The `<title>` is read from the head either way (the
  // whole input when there is no `</head>`), so an SVG's `<title>` in the body is
  // never taken for the page's.
  through: 'head' | 'document';
}

// Fill the shared candidate bag. FIRST non-empty value per key wins (head order ≈ page
// intent — the extractor's `??=` rule, matched exactly); icons are collected in
// document order because choosing between them is `selectFaviconUrl`'s job.
export function scanHtmlMeta(
  html: string,
  { maxChars, through }: ScanHtmlMetaOptions,
): CollectedMeta {
  const { text, headEnd } = strippedOf(html, maxChars, through === 'head');
  const head = headEnd === -1 ? text : text.slice(0, headEnd);
  const tags = through === 'document' ? text : head;
  const collected: CollectedMeta = {};

  const title = nextSpan(head, /<title/gi, /<\/title\s*>/gi, true, 0);
  if (title) collected.docTitle = decodeHtmlEntities(title.body);

  for (const raw of tagAttrs(tags, /<meta\b/gi)) {
    const attrs = parseAttrs(raw);
    const content = attrs.content?.trim();
    if (!content) continue;

    // `property` (OpenGraph) and `name` (Twitter/legacy) both checked — sites use
    // either, and some use both on one tag.
    for (const key of [attrs.property, attrs.name]) {
      switch (key?.toLowerCase()) {
        case 'og:title':
          collected.ogTitle ??= content;
          break;
        case 'og:image':
          collected.ogImage ??= content;
          break;
        case 'og:image:url':
          collected.ogImageUrl ??= content;
          break;
        case 'og:image:secure_url':
          collected.ogImageSecure ??= content;
          break;
        case 'twitter:image':
        case 'twitter:image:src':
          collected.twitterImage ??= content;
          break;
        default:
          break;
      }
    }
  }

  for (const raw of tagAttrs(tags, /<link\b/gi)) {
    const attrs = parseAttrs(raw);
    const rel = attrs.rel?.toLowerCase();
    const href = attrs.href?.trim();
    if (!rel || !href) continue;

    const rels = rel.split(/\s+/);
    if (rels.includes('image_src')) collected.imageSrc ??= href;
    // Every icon-ish rel is collected raw (`icon`, `shortcut icon`, `apple-touch-icon`,
    // `mask-icon`); selectFaviconUrl filters the unrenderable ones and ranks the rest.
    if (rels.some((token) => token.includes('icon'))) {
      collected.icons ??= [];
      collected.icons.push({ href, rel, sizes: attrs.sizes, type: attrs.type });
    }
  }

  return collected;
}
