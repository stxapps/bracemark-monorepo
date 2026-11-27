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
// comments and inline scripts containing tag-like text, single/unquoted attributes, a
// `>` inside a quoted value (`content="Home > Shop"`, tagEnd) — not a general-purpose
// HTML implementation. The other thing a real parser does for
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
//
// The FIRST of a repeated attribute wins, and a name with no value has the empty one —
// both as the DOM's `getAttribute` has it, so `<meta content content="x">` has no
// content here either.
//
// At most MAX_TAG_ATTRIBUTES are read: a real `<meta>` or `<link>` has two to five, and
// a hostile one with 500 K names would otherwise cost a regex call each (the Hermes note).
const MAX_TAG_ATTRIBUTES = 64;
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null);
  const re = /([a-z_:][-a-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/gi;
  let read = 0;
  for (let m = re.exec(raw); m !== null && read < MAX_TAG_ATTRIBUTES; m = re.exec(raw)) {
    read++;
    const key = m[1].toLowerCase();
    if (key in attrs) continue;
    const value = m[2] ?? m[3] ?? m[4];
    attrs[key] = value === undefined ? '' : decodeHtmlEntities(value);
  }
  return attrs;
}

// WHY THE SCAN BELOW IS HAND-ROLLED. Every construct it reads — a comment, a
// script/style body, a `<title>`, a `<meta …>` — is an opener followed by a closer,
// and the obvious regex for one (`/<meta\b[^>]*>/g`, `/<!--.*?-->/gs`) is quadratic
// when an opener never closes: the engine scans to the end, fails, and starts over
// from the NEXT opener, which fails the same way. The fact a regex can't use is that
// a closer missing after one opener is missing after every later one — so the walk
// below finds an opener by regex, its end by searching forward from it, and stops at
// the first miss. Nothing a real page does trips
// the regex version; a hostile one did, on every engine — `<meta` × 32,000 (156 KB)
// held Hermes for 14 s, `<meta ` × 32,000 (188 KB) for 17 s (re-measured 2026-11-26,
// RN 0.81's Hermes CLI on an M1). docs/link-extraction.md, _three collectors_.
//
// ⚠ ON HERMES, COUNT THE CALLS, NOT THE CHARACTERS. Linear is not enough there: a regex
// `exec` or `test` costs about a microsecond however little it matches, so a scan that
// makes one call per character, per `=` or per tag of a hostile page spends a second
// on a megabyte. The walk makes a call per TAG, and inside a tag a call per quoted
// value (tagEnd); runs of anything else are crossed inside one native call. `tagEnd`
// once made a call per `=`, and `<meta a= = = …>` (one tag, 512 K `=`) took 0.5 s a
// scan; the single regex below takes 16 ms.
//
// ⚠ Where a body IS matched by regex, it is `.*?` + `s`, never `[\s\S]*?`: on Hermes
// the class spelling costs time in proportion to the rest of the input on every
// match (`@stxapps/shared` import/netscape.ts). The `REGEX_SYNTAX` lint rule holds it.

// Where the tag whose attributes begin at `from` ends: the first `>` outside a quoted
// attribute VALUE, as the HTML tokenizer has it — a quote opens a value only right
// after `=` (and any spaces), so a stray `"` elsewhere in a tag is just a character.
// The first `>` alone cut `<meta property="og:title" content="Home > Shop">` at
// "Home ", losing the title, where the live DOM and `HTMLRewriter` read it whole.
// -1 when nothing ends it — no `>`, or a quoted value that never closes.
//
// A value whose quote never closes swallows the rest of the input, as in a browser and
// in `HTMLRewriter`, so the walk ends there. In a CAPPED input that is the only safe
// reading: the quote may close past the cut, and the text after it is a value. The rule
// before 2026-11-27 ended such a tag at the next `>` and read on, which read a long
// `data-props="…"` cut by the cap as tags — a visitor's text inside it could choose the
// preview. Linear: the walk only moves forward, and each quote's closer is searched
// once and jumped past.
//
// One regex finds both stops — a `>`, or an `=` whose value opens with a quote — so an
// `=` with a bare value (or none) costs no call of its own (the Hermes note above). The
// spaces it allows before the quote are the tokenizer's (tab, LF, FF, CR, space): `\s`
// would take a no-break space for one, and `alt=\u00a0"x>…"` would skip a value the DOM
// never opened.
const TAG_STOP = /=[\t\n\f\r ]*(["'])|>/g;
function tagEnd(text: string, from: number): number {
  let at = from;
  for (;;) {
    TAG_STOP.lastIndex = at;
    const stop = TAG_STOP.exec(text);
    if (stop === null) return -1;
    const quote = stop[1];
    if (quote === undefined) return stop.index;
    const close = text.indexOf(quote, stop.index + stop[0].length);
    if (close === -1) return -1;
    at = close + 1;
  }
}

// The elements whose content the HTML parser reads as TEXT, or keeps out of the
// document (`<template>`'s fragment): nothing inside one is an element
// `querySelectorAll('meta')` would find, so a `<meta>` written inside one is not the
// page's. A page that lets a visitor post raw markup into a `<textarea>` or a
// `<noscript>` (or an attribute value, or a CDATA section — handled by the walk) would
// otherwise let that visitor choose the preview: the og tags in the body are read when
// the head declares none (`through: 'document'`). `<noscript>` is text because every
// page this runs on has scripting on. A `<template>` ends at its first `</template`,
// which a parser does not do when that end tag sits inside a nested template or inside
// a raw-text element, comment or attribute in the template's content: a `<meta>` after
// it is then read as the page's (docs/link-extraction.md, _what the scanner still
// reads differently_).
const RAW_TEXT = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'template',
]);

// What may follow `<` for the tokenizer to see markup there: a tag (`a`–`z`), an end
// tag (`/`), a comment, doctype or CDATA (`!`), a processing instruction (`?`). A `<`
// before anything else is text (`a < b`); a run of those is crossed in this one call.
const MARKUP_OPEN = /<[a-zA-Z!?/]/g;

// Where a comment ends: `-->`, or `--!>` (the tokenizer's comment-end-bang state). The
// empty forms `<!-->` and `<!--->` are the walk's own check. One call per comment.
const COMMENT_END = /--!?>/g;

const isLetter = (code: number): boolean => (code | 0x20) >= 0x61 && (code | 0x20) <= 0x7a;
// What ends a tag name: whitespace, `/`, `>` (the tokenizer's rule).
const endsName = (code: number): boolean =>
  code === 0x20 ||
  code === 0x09 ||
  code === 0x0a ||
  code === 0x0c ||
  code === 0x0d ||
  code === 0x2f ||
  code === 0x3e;
// Whether `text` holds `name` (lowercase ASCII) at `at`, in any ASCII case. The
// tokenizer lowercases ASCII only; `String#toLowerCase` also folds U+212A KELVIN SIGN to
// `k`, which made `<linK …>` a `<link>` here and an unknown element to the DOM.
// `(code | 0x20)` is a lowercase letter only for that letter's two ASCII cases.
const isNameAt = (text: string, at: number, name: string): boolean => {
  for (let i = 0; i < name.length; i++) {
    if ((text.charCodeAt(at + i) | 0x20) !== name.charCodeAt(i)) return false;
  }
  return true;
};
// Every start tag the walk acts on, keyed by (first letter, length) — so a tag that can't
// be one of them (`<p>`, `<a>`, `<div>`) costs a lookup and nothing more.
const actedOnKey = (firstCode: number, length: number): number => (firstCode | 0x20) * 64 + length;
const ACTED_ON = new Map<number, string[]>();
for (const name of ['meta', 'link', 'plaintext', ...RAW_TEXT]) {
  const key = actedOnKey(name.charCodeAt(0), name.length);
  ACTED_ON.set(key, [...(ACTED_ON.get(key) ?? []), name]);
}

interface Scanned {
  // The first `<title>`'s text before `</head>` (anywhere, when the head never closes).
  title?: string;
  // Each `<meta>` / `<link>` tag's attribute text, in document order.
  metas: string[];
  links: string[];
  // Just past the `>` of the first `</head>` outside every comment, raw-text body and
  // tag — where the body begins — when the walk reached one.
  headEnd?: number;
}

// ONE WALK, IN DOCUMENT ORDER, tag by tag, as the HTML tokenizer reads the input — so
// that text the browser reads as text stays text here, wherever it sits: a comment, a
// bogus comment (`<!DOCTYPE …>`, `<?…>`, `</ …>`), a CDATA section, a raw-text body
// (RAW_TEXT), an attribute VALUE (tagEnd skips quoted values whole: `<img
// alt='<meta property="og:image" …>'>` is an `<img>`). Each is routinely full of
// tag-like text — a commented-out og tag left by a CMS, a JS string holding `<title>` or
// `</head>` — and a scanner that doesn't skip it collects it as if the page had
// declared it.
//
// It stops at the first `</head>` when asked (`stopAtHead`), so the page's body is never
// looked at: what lets MAX_HEAD_CHARS (expo-react parse-html-head.ts) be large enough
// for YouTube without making every other page pay for it.
//
// A span that never closes — a comment, a CDATA section, a raw-text body, a tag, a
// quoted attribute value — runs to the end of the input, as it does in the browser, so
// the walk ends there. That is also the honest reading of a CAPPED input: a script or a
// value cut by `maxChars` goes on past it, and its text is not markup. (The rule before
// 2026-11-26 read on past an unclosed span to keep a broken page's later tags; it read a
// cut script's strings as tags, which is how a visitor's comment inside a page's inline
// data could become its preview. A quoted value kept that rule until 2026-11-27.) So the
// walk never guesses, and a `</head>` it reaches is where the head ends in any longer
// read of the same page. Linear, and a call or two per tag (the Hermes note above):
// markup openers are found by one regex from the walk's position, a closer is searched
// once and jumped past, a tag's end is tagEnd's.
//
// `bodyFrom` resumes a walk that stopped at `</head>` (its `headEnd`): the state there
// is only the position and "the head has closed", so the two walks read exactly what
// one `through: 'document'` walk would.
function scanTags(html: string, maxChars: number, stopAtHead: boolean, bodyFrom?: number): Scanned {
  const text = html.length > maxChars ? html.slice(0, maxChars) : html;
  const out: Scanned = { metas: [], links: [] };
  if (bodyFrom !== undefined) out.headEnd = bodyFrom;
  let pos = bodyFrom ?? 0;
  // Each raw-text element's end tag, compiled once per call.
  const closers = new Map<string, RegExp>();
  const closerOf = (name: string): RegExp => {
    let closer = closers.get(name);
    if (closer === undefined) {
      closer = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi');
      closers.set(name, closer);
    }
    return closer;
  };

  // The next `"` and `'` at or after the walk, kept until the walk passes them, so a tag
  // with no quote before its `>` ends there with no tagEnd call — and no stretch of text
  // is searched twice for a quote (each search starts past the last one found).
  let nextDouble = -1;
  let nextSingle = -1;
  // Where the tag whose name ends at `from` ends: its first `>`, when no quote comes
  // before it; else tagEnd's answer. -1 when nothing ends it.
  const endOfTag = (from: number): number => {
    const gt = text.indexOf('>', from);
    if (gt === -1) return -1;
    if (nextDouble !== -2 && nextDouble < from) {
      nextDouble = text.indexOf('"', from);
      if (nextDouble === -1) nextDouble = -2; // none left: never search again
    }
    if (nextSingle !== -2 && nextSingle < from) {
      nextSingle = text.indexOf("'", from);
      if (nextSingle === -1) nextSingle = -2;
    }
    const quoteFirst =
      (nextDouble !== -2 && nextDouble < gt) || (nextSingle !== -2 && nextSingle < gt);
    return quoteFirst ? tagEnd(text, from) : gt;
  };
  // Where a name starting at `from` ends.
  const nameEnd = (from: number): number => {
    let at = from;
    while (at < text.length && !endsName(text.charCodeAt(at))) at++;
    return at;
  };

  for (;;) {
    let lt = text.indexOf('<', pos);
    if (lt === -1) break;
    let next = text.charCodeAt(lt + 1);
    if (!isLetter(next) && next !== 0x21 && next !== 0x3f && next !== 0x2f) {
      // Text `<`s, crossed in one call to the next one that opens markup.
      MARKUP_OPEN.lastIndex = lt + 1;
      const open = MARKUP_OPEN.exec(text);
      if (open === null) break;
      lt = open.index;
      next = text.charCodeAt(lt + 1);
    }

    if (next === 0x21 /* ! */ || next === 0x3f /* ? */) {
      if (text.startsWith('<!--', lt)) {
        const body = lt + 4;
        if (text.charCodeAt(body) === 0x3e /* <!--> */) {
          pos = body + 1;
          continue;
        }
        if (text.startsWith('->', body) /* <!---> */) {
          pos = body + 2;
          continue;
        }
        COMMENT_END.lastIndex = body;
        const close = COMMENT_END.exec(text);
        if (close === null) break; // the rest of the input is the comment
        pos = close.index + close[0].length;
        continue;
      }
      // CDATA is text inside <svg>/<math> and a bogus comment elsewhere; skipped to its
      // `]]>` either way — the DOM's text, or, in HTML content, MORE than the DOM's bogus
      // comment (which ends at the first `>`). With no `]]>` the walk ends: in foreign
      // content the section runs to the end, and in a capped input it may close past it.
      if (text.startsWith('<![CDATA[', lt)) {
        const close = text.indexOf(']]>', lt + 9);
        if (close === -1) break;
        pos = close + 3;
        continue;
      }
      // A bogus comment (`<!DOCTYPE html>`, `<?xml …?>`) ends at its first `>`; none means
      // the rest of the input is inside it.
      const gt = text.indexOf('>', lt + 2);
      if (gt === -1) break;
      pos = gt + 1;
      continue;
    }

    if (next === 0x2f /* / */) {
      if (!isLetter(text.charCodeAt(lt + 2))) {
        // `</>` is dropped; `</` before anything else opens a bogus comment.
        const gt = text.indexOf('>', lt + 2);
        if (gt === -1) break;
        pos = gt + 1;
        continue;
      }
      const end = nameEnd(lt + 3);
      const gt = endOfTag(end);
      if (gt === -1) break;
      pos = gt + 1;
      if (out.headEnd === undefined && end - lt === 6 && isNameAt(text, lt + 2, 'head')) {
        out.headEnd = pos;
        if (stopAtHead) break;
      }
      continue;
    }

    const attrsStart = nameEnd(lt + 2);
    const gt = endOfTag(attrsStart);
    if (gt === -1) break; // EOF inside a tag: the browser drops it, and there is no more
    pos = gt + 1;

    const candidates = ACTED_ON.get(actedOnKey(next, attrsStart - lt - 1));
    if (candidates === undefined) continue;
    let name: string | undefined;
    for (let i = 0; i < candidates.length && name === undefined; i++) {
      if (isNameAt(text, lt + 1, candidates[i])) name = candidates[i];
    }
    if (name === undefined) continue;
    if (name === 'meta') out.metas.push(text.slice(attrsStart, gt));
    else if (name === 'link') out.links.push(text.slice(attrsStart, gt));
    else if (name === 'plaintext')
      break; // the rest of the input is its text
    else if (RAW_TEXT.has(name)) {
      // The body runs to the first `</name` that ends a tag name there (`</titles>`
      // doesn't close a title; the closer's case is free) — and the walk then reads that
      // end tag itself, so a `</head>` inside a script never counts.
      const closer = closerOf(name);
      closer.lastIndex = pos;
      const close = closer.exec(text);
      if (close === null) break; // the rest of the input is its text
      if (name === 'title' && out.title === undefined && out.headEnd === undefined) {
        out.title = text.slice(pos, close.index);
      }
      pos = close.index;
    }
  }
  return out;
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
  // ~575 KB later, in the body. The `<title>` is read from the head either way, so an
  // SVG's `<title>` in the body is not taken for the page's — when the page closes its
  // head. With no `</head>` (an optional tag) the whole input is the head, and an SVG
  // `<title>` before any other is taken.
  through: 'head' | 'document';
}

// Fill the shared candidate bag. FIRST non-empty value per key wins (head order ≈ page
// intent — the extractor's `??=` rule, matched exactly); icons are collected in
// document order because choosing between them is `selectFaviconUrl`'s job.
export function scanHtmlMeta(html: string, options: ScanHtmlMetaOptions): CollectedMeta {
  return scanHtmlMetaReport(html, options).collected;
}

// scanHtmlMeta, plus `headEnd`: just past the first `</head>` the walk reached, where the
// body begins — undefined when the head never closed in what was read. A head that
// closed is SETTLED: every span before `</head>` closed inside the read (the walk ends at
// one that doesn't, and never guesses), and the first value of each key wins, so no
// longer read of the same page could change a `through: 'head'` answer. expo-react
// parse-html-head.ts reads a page's first bytes and asks this before deciding whether it
// needs the rest, and resumes from `headEnd` when it needs the body (scanHtmlBodyMeta).
export function scanHtmlMetaReport(
  html: string,
  { maxChars, through }: ScanHtmlMetaOptions,
): { collected: CollectedMeta; headEnd?: number } {
  const scanned = scanTags(html, maxChars, through === 'head');
  return { collected: collectedOf(scanned), headEnd: scanned.headEnd };
}

// The body's tags of a page whose head was already read `through: 'head'`, from that
// read's `headEnd` on: what a `through: 'document'` scan would add, without reading the
// head a second time. No `docTitle` (the title is the head's). A hostile head the size
// of the cap then costs one walk, not two.
export function scanHtmlBodyMeta(
  html: string,
  { maxChars, headEnd }: { maxChars: number; headEnd: number },
): CollectedMeta {
  return collectedOf(scanTags(html, maxChars, false, headEnd));
}

function collectedOf(scanned: Scanned): CollectedMeta {
  const collected: CollectedMeta = {};

  if (scanned.title !== undefined) collected.docTitle = decodeHtmlEntities(scanned.title);

  for (const raw of scanned.metas) {
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

  for (const raw of scanned.links) {
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
