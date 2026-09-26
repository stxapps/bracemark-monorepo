import { type CollectedMeta, CP1252_HIGH, decodeHtmlEntities } from '@stxapps/shared';

// Collect a page's title/image/icon CANDIDATES out of its raw HTML — the Hermes-side
// counterpart of bracemark-extractor's `HTMLRewriter` pass (apps/bracemark-extractor/src/lib/
// html.ts). It fills the same `CollectedMeta` bag, and WHICH candidate wins is decided
// by the shared `selectTitleImage`/`selectFaviconUrl` (shared extract/select.ts), so
// `expo:fg` and `server` can never disagree about what "the page's title" means — the
// property that makes a tier upgrade an improvement rather than a change.
//
// WHY A REGEX SCANNER AND NOT A PARSER. React Native has no DOM (`DOMParser`,
// `HTMLRewriter` — neither exists on Hermes), so the choice is a JS parser dependency
// (htmlparser2 & co.) or a scanner. We need five tag shapes out of `<head>` —
// `<title>`, `<meta>`, `<link rel=icon|image_src>` — from bounded, already-fetched
// bytes, with no tree, no scripts and no error recovery to speak of. A dependency
// would buy correctness we can't use and ship a parser into the app bundle for it, so:
// a scanner, kept honest by fixtures (parse-html-head.spec.ts). The pieces below are
// the malformed-input hazards that actually bite in the wild — comments and inline
// scripts containing tag-like text, single/unquoted attributes — not a general-purpose
// HTML implementation. The other thing a real parser does for free, resolving
// character references, is `@stxapps/shared`'s `decodeHtmlEntities` (html/entities.ts),
// shared with bracemark-extractor because `HTMLRewriter` doesn't decode either; every
// value collected here goes through it, since the DOM the extension reads would have.

// How much of the response we look at. Everything we want is in `<head>`, which is
// tiny; this is the backstop for a page that never closes it (or a multi-MB inline
// script above the metadata). The fetcher caps the response separately — this caps the
// SCAN, so a pathological body costs bounded regex work.
export const MAX_HEAD_CHARS = 256 * 1024;

// The windows-1252 high range is `@stxapps/shared`'s `CP1252_HIGH` (html/entities.ts),
// shared with the numeric-reference remap that needs the same 32 characters. Pages
// that declare (or are served as) `iso-8859-1` are windows-1252 in practice — smart
// quotes, dashes and ellipsis, i.e. exactly the characters a real page title uses —
// and every browser decodes them that way; matching that is the difference between
// `It’s` and `It?s`.

function decodeCp1252(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    // The five unassigned slots in that range are '' in the shared table; those (and
    // every byte outside it) fall through to the latin-1 identity mapping.
    const high = byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : '';
    out += high === '' ? String.fromCharCode(byte) : high;
  }
  return out;
}

// The charset a response declares, lowercased: the `Content-Type` header first (it
// wins over the document per HTML's own precedence), then a `<meta charset>` /
// `<meta http-equiv="content-type">` sniffed out of the first bytes — read as ASCII,
// which every candidate encoding is a superset of in that range.
function declaredCharset(bytes: Uint8Array, contentType: string | undefined): string | undefined {
  const fromHeader = contentType ? /charset\s*=\s*"?([\w-]+)/i.exec(contentType) : null;
  if (fromHeader) return fromHeader[1].toLowerCase();

  const head = decodeCp1252(bytes.subarray(0, 2048));
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head) ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w-]+)/i.exec(head);
  return fromMeta ? fromMeta[1].toLowerCase() : undefined;
}

// Bytes → text, honoring the declared charset as far as the runtime allows.
//
// Hermes ships `TextDecoder` for utf-8 only (Expo's winter runtime installs the
// polyfill; neither implements the full encoding registry), so a legacy-encoded page
// has no correct decoder available. Rather than hand a mojibake title to the writer we
// degrade DELIBERATELY: utf-8 (the overwhelming default) decodes properly; anything
// single-byte-Latin decodes as windows-1252, which is right for the western-European
// long tail; a legacy multi-byte encoding (Shift_JIS, GB2312, EUC-KR) is the one case
// we can't serve — it yields a wrong title on a facet the user can override with
// `customTitle`, and the alternative is bundling an encoding library for a shrinking
// slice of the web. Don't "fix" this without measuring what it costs.
export function decodeHtmlBytes(bytes: Uint8Array, contentType?: string): string {
  const charset = declaredCharset(bytes, contentType);
  if (charset !== undefined && /^(iso-?8859-1|windows-1252|latin1|ascii|us-ascii)$/.test(charset)) {
    return decodeCp1252(bytes);
  }
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
}

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

// Every complete `open … close` span replaced by a space; an unclosed opener and all
// that follows it are left as they are (a page that never closes a comment keeps its
// later metadata — the scanner's choice, not HTML's).
function stripSpans(text: string, open: RegExp, close: RegExp, openIsTag: boolean): string {
  const kept: string[] = [];
  let pos = 0;
  for (
    let span = nextSpan(text, open, close, openIsTag, pos);
    span !== undefined;
    span = nextSpan(text, open, close, openIsTag, pos)
  ) {
    kept.push(text.slice(pos, span.start));
    pos = span.end;
  }
  kept.push(text.slice(pos));
  return kept.join(' ');
}

// Everything before `</head>` (or the whole capped input if the page never closes it),
// with comments and inline script/style bodies removed FIRST. That order matters: both
// routinely contain tag-like text — a commented-out `<meta property="og:image">` left
// by a CMS, or a JS string containing `<title>` — and a scanner that doesn't strip
// them will happily collect it as if the page had declared it.
function headOf(html: string): string {
  const capped = html.length > MAX_HEAD_CHARS ? html.slice(0, MAX_HEAD_CHARS) : html;
  let stripped = stripSpans(capped, /<!--/g, /-->/g, false);
  stripped = stripSpans(stripped, /<script\b/gi, /<\/script\s*>/gi, true);
  stripped = stripSpans(stripped, /<style\b/gi, /<\/style\s*>/gi, true);
  const end = stripped.search(/<\/head\s*>/i);
  return end === -1 ? stripped : stripped.slice(0, end);
}

// Every `<name …>` tag's attribute text, in document order.
function tagAttrs(head: string, open: RegExp): string[] {
  const found: string[] = [];
  for (let tag = nextTag(head, open, 0); tag !== undefined; tag = nextTag(head, open, tag.end)) {
    found.push(tag.attrs);
  }
  return found;
}

// Fill the shared candidate bag. FIRST non-empty value per key wins (head order ≈ page
// intent — the extractor's `??=` rule, matched exactly); icons are collected in
// document order because choosing between them is `selectFaviconUrl`'s job.
export function parseHtmlHead(html: string): CollectedMeta {
  const head = headOf(html);
  const collected: CollectedMeta = {};

  const title = nextSpan(head, /<title/gi, /<\/title\s*>/gi, true, 0);
  if (title) collected.docTitle = decodeHtmlEntities(title.body);

  for (const raw of tagAttrs(head, /<meta\b/gi)) {
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

  for (const raw of tagAttrs(head, /<link\b/gi)) {
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
