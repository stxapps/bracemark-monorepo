import {
  type CollectedMeta,
  declaredCharset,
  decodeCp1252,
  isWindows1252Label,
  scanHtmlMeta,
} from '@stxapps/shared';

// Collect a page's title/image/icon CANDIDATES out of the raw HTML the app fetched — the
// Hermes-side counterpart of bracemark-extractor's `HTMLRewriter` pass
// (apps/bracemark-extractor/src/lib/html.ts). The scanner itself is `@stxapps/shared`
// html/scan-meta.ts — linear on a hostile page, and why a scanner rather than a parser
// is said there — shared with web-react's in-page re-read of a stale head
// (lib/page-meta.ts). What is this file's own is the byte decode below and the cap.

// How much of the response the scan reads. Not what a page's head costs — the head
// scan stops at `</head>`, so a 2 MB Wikipedia article whose head closes at 16 KB costs
// 16 KB — but how far it will go to FIND the metadata, which bounds a page that never
// closes its head, or declares its og tags in its body, and every hostile shape.
//
// 1 MiB, measured 2026-11-22 over 87 pages fetched with the app's User-Agent (the
// kept-copies set, e2e/measure/kept-copies-pages.ts, and ~25 large sites): every page
// but YouTube's had its title and image within 128 KB (Facebook and Instagram the
// furthest), and every YouTube page needed ~900 KB — its watch pages declare og:title
// at 828–856 KB, inside a head the size of its inline data, and its channel pages at
// 876 KB, in the body after a head that closes at 825 KB. Nothing fell between. The
// cap was 256 KB, and the app took no title or image from any YouTube link. It is CLOSE
// to what bracemark-extractor reads of the same page, not equal: its `MAX_HTML_BYTES`
// (lib/safe-fetch.ts) is 1,000,000 bytes and this is 1,048,576 characters, so this reads
// ~48 K further on an ASCII page and more on a multi-byte one. Every offset measured
// above sits under both. Keep the two near each other: a tier that reads much further
// than another finds tags the other can't, and a tier upgrade must be an improvement,
// not a change.
//
// The cost lands on the JS thread: a scan through the whole cap is ~8–9 ms per MB on
// Hermes on an M1 (from the 244 KB head's 2 ms, docs/link-extraction.md, _three
// collectors_), so perhaps 30–45 ms on a low-end Android phone — two or three frames,
// once per such page. Each scan follows its own page fetch (CONCURRENCY in
// device-link-previews.ts), so they never run back to back as one long stall.
export const MAX_HEAD_CHARS = 1024 * 1024;

// Bytes → text, honoring the declared charset as far as the runtime allows. WHICH
// charset is `@stxapps/shared`'s `declaredCharset` (html/charset.ts), the same sniff
// bracemark-extractor's read mode runs; the decode is this runtime's own.
//
// Hermes ships `TextDecoder` for utf-8 only (Expo's winter runtime installs the
// polyfill; neither implements the full encoding registry), so a legacy-encoded page
// has no correct decoder available. Rather than hand a mojibake title to the writer we
// degrade DELIBERATELY: utf-8 (the overwhelming default) decodes properly; every label
// WHATWG maps to windows-1252 (latin-1, ascii and their aliases) decodes through the
// cp1252 table, which is right for the western-European long tail; a legacy multi-byte encoding (Shift_JIS, GB2312, EUC-KR) is the one case
// we can't serve — it yields a wrong title on a facet the user can override with
// `customTitle`, and the alternative is bundling an encoding library for a shrinking
// slice of the web. Don't "fix" this without measuring what it costs.
export function decodeHtmlBytes(bytes: Uint8Array, contentType?: string): string {
  const charset = declaredCharset(bytes, contentType);
  if (charset !== undefined && isWindows1252Label(charset)) return decodeCp1252(bytes);
  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
}

// The fields that say a head declared its metadata — OpenGraph, Twitter, image_src.
// `<title>` and icons don't count: a head with only those is the shape of a page that put
// its og tags in the body.
const DECLARED_FIELDS = [
  'ogTitle',
  'ogImage',
  'ogImageUrl',
  'ogImageSecure',
  'twitterImage',
  'imageSrc',
] as const satisfies readonly (keyof CollectedMeta)[];

// A fetched page as `CollectedMeta`: its head, scanned up to `</head>`; and when the head
// declared none of DECLARED_FIELDS, the whole page under MAX_HEAD_CHARS, for the og tags
// a page declares in its body (YouTube's channel pages) — where the other two collectors
// find them too, since the live DOM and `HTMLRewriter` read a `<meta>` anywhere. Only a
// head with nothing pays for the body: one that has og:title and no image has said what
// it has. The icons stay the head's, the place a favicon is declared. WHICH candidate
// wins is `selectTitleImage`'s call.
export function parseHtmlHead(html: string): CollectedMeta {
  const head = scanHtmlMeta(html, { maxChars: MAX_HEAD_CHARS, through: 'head' });
  if (DECLARED_FIELDS.some((field) => head[field] !== undefined)) return head;

  const whole = scanHtmlMeta(html, { maxChars: MAX_HEAD_CHARS, through: 'document' });
  delete whole.icons;
  if (head.icons) whole.icons = head.icons;
  return whole;
}
