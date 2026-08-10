import type { CollectedMeta } from '@stxapps/shared';

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
// scripts containing tag-like text, single/unquoted attributes, entity-escaped titles
// — not a general-purpose HTML implementation.

// How much of the response we look at. Everything we want is in `<head>`, which is
// tiny; this is the backstop for a page that never closes it (or a multi-MB inline
// script above the metadata). The fetcher caps the response separately — this caps the
// SCAN, so a pathological body costs bounded regex work.
export const MAX_HEAD_CHARS = 256 * 1024;

// The 0x80–0x9F range where windows-1252 differs from latin-1 — smart quotes, dashes
// and ellipsis, i.e. exactly the characters a real page title uses. Pages that declare
// (or are served as) `iso-8859-1` are windows-1252 in practice, and every browser
// decodes them that way; matching that is the difference between `It’s` and `It?s`.
const CP1252_HIGH = [
  '€',
  '',
  '‚',
  'ƒ',
  '„',
  '…',
  '†',
  '‡',
  'ˆ',
  '‰',
  'Š',
  '‹',
  'Œ',
  '',
  'Ž',
  '',
  '',
  '‘',
  '’',
  '“',
  '”',
  '•',
  '–',
  '—',
  '˜',
  '™',
  'š',
  '›',
  'œ',
  '',
  'ž',
  'Ÿ',
];

function decodeCp1252(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    // The five unassigned slots in that range map to '' in the table above; those (and
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

// The named entities worth resolving in a title (`&amp;` and friends), plus numeric
// refs. Anything else is left literal: a title is display text, so an unresolved
// `&hellip;` is a cosmetic miss, while a full entity table is a lot of bytes to carry
// for one field.
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// One tag's attributes as a lowercase-keyed map. Handles double-quoted, single-quoted
// and bare values — all three appear in the wild, and a missed `content` is a missed
// og:title.
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

// Everything before `</head>` (or the whole capped input if the page never closes it),
// with comments and inline script/style bodies removed FIRST. That order matters: both
// routinely contain tag-like text — a commented-out `<meta property="og:image">` left
// by a CMS, or a JS string containing `<title>` — and a scanner that doesn't strip
// them will happily collect it as if the page had declared it.
function headOf(html: string): string {
  const capped = html.length > MAX_HEAD_CHARS ? html.slice(0, MAX_HEAD_CHARS) : html;
  const stripped = capped
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ');
  const end = stripped.search(/<\/head\s*>/i);
  return end === -1 ? stripped : stripped.slice(0, end);
}

// Fill the shared candidate bag. FIRST non-empty value per key wins (head order ≈ page
// intent — the extractor's `??=` rule, matched exactly); icons are collected in
// document order because choosing between them is `selectFaviconUrl`'s job.
export function parseHtmlHead(html: string): CollectedMeta {
  const head = headOf(html);
  const collected: CollectedMeta = {};

  const title = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  if (title) collected.docTitle = decodeEntities(title[1]);

  const metaRe = /<meta\b([^>]*)>/gi;
  for (let m = metaRe.exec(head); m !== null; m = metaRe.exec(head)) {
    const attrs = parseAttrs(m[1]);
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

  const linkRe = /<link\b([^>]*)>/gi;
  for (let m = linkRe.exec(head); m !== null; m = linkRe.exec(head)) {
    const attrs = parseAttrs(m[1]);
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
