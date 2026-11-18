import { CP1252_HIGH } from './entities';

// The charset an HTML response DECLARES — the question both raw-HTML readers ask before
// they can turn bytes into text: bracemark-extractor's server read mode
// (apps/bracemark-extractor/src/lib/read-mode.ts, `decodeHtml`) and bracemark-expo's
// head scanner (expo-react lib/parse-html-head.ts, `decodeHtmlBytes`). The live DOM
// answers it for the browser extension, so nothing there asks.
//
// SNIFF HERE, DECODE PER PLATFORM. Which charset a page names is a fact about its bytes,
// so it has one answer everywhere. What a runtime can DO with the answer is not: workerd's
// `TextDecoder` knows every WHATWG label, while Hermes's decodes UTF-8 and nothing else.
// A shared `new TextDecoder(label)` would throw on Hermes for every latin-1 page, fall
// back to UTF-8, and store mojibake titles with no error anywhere — so the decode stays
// beside each caller, and only the sniff (and the one decoder every engine can run,
// `decodeCp1252`) lives here.

// The windows-1252 bytes as text, with no `TextDecoder` — so it runs on Hermes, which has
// no decoder for it. Pages that declare (or are served as) `iso-8859-1` are windows-1252
// in practice, and every browser decodes them that way: the 0x80–0x9F range holds the
// smart quotes, dashes and ellipsis a real page title uses, so this is the difference
// between `It’s` and `It?s`. The table is `CP1252_HIGH` (entities.ts), shared with the
// numeric-reference remap that needs the same 32 characters.
export function decodeCp1252(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    // The five unassigned slots in that range are '' in the table; those (and every byte
    // outside it) fall through to the latin-1 identity mapping.
    const high = byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80] : '';
    out += high === '' ? String.fromCharCode(byte) : high;
  }
  return out;
}

// Every label the WHATWG Encoding Standard maps to windows-1252 — i.e. every declared
// charset `decodeCp1252` decodes correctly, so a runtime with no decoder of its own for
// them (Hermes) can still serve those pages. The list is the standard's, ASCII included:
// `us-ascii` IS windows-1252 there, which is what a browser does with it.
export const WINDOWS_1252_LABELS: ReadonlySet<string> = new Set([
  'ansi_x3.4-1968',
  'ascii',
  'cp1252',
  'cp819',
  'csisolatin1',
  'ibm819',
  'iso-8859-1',
  'iso-ir-100',
  'iso8859-1',
  'iso88591',
  'iso_8859-1',
  'iso_8859-1:1987',
  'l1',
  'latin1',
  'us-ascii',
  'windows-1252',
  'x-cp1252',
]);

// Whether a charset label (as `declaredCharset` returns it, lowercased) names windows-1252.
export function isWindows1252Label(label: string): boolean {
  return WINDOWS_1252_LABELS.has(label);
}

// How far into the body a `<meta>` charset is looked for — HTML's own prescan length, so
// a page whose declaration sits later is read the way a browser reads it (as undeclared).
// It also bounds the regex work below on a hostile page: these patterns are not linear
// (docs/link-extraction.md, _the scanner must stay linear_), and on 1 KB that can't matter.
export const CHARSET_PRESCAN_BYTES = 1024;

// The charset label a response declares, lowercased, or undefined when it names none: the
// `Content-Type` header's `charset` parameter first (it wins over the document, per HTML's
// own precedence), then a `<meta charset>` — or its `<meta http-equiv="content-type"
// content="…; charset=…">` spelling — in the first CHARSET_PRESCAN_BYTES.
//
// The label is returned as written, not validated: whether this runtime can decode it is
// the caller's question. The value runs to the first delimiter rather than matching
// `[\w-]+`, because real WHATWG labels include `iso_8859-1:1987` and `ansi_x3.4-1968`.
export function declaredCharset(
  bytes: Uint8Array,
  contentType: string | null | undefined,
): string | undefined {
  // `;`-anchored: `charset` is a parameter, never the media type itself.
  const fromHeader = /;\s*charset\s*=\s*"?([^\s";]+)/i.exec(contentType ?? '');
  if (fromHeader) return fromHeader[1].toLowerCase();

  // Read as windows-1252, which every candidate encoding agrees with in the ASCII range
  // the declaration is written in.
  const head = decodeCp1252(bytes.subarray(0, CHARSET_PRESCAN_BYTES));
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([^\s"';>/]+)/i.exec(head) ??
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^\s"';>/]+)/i.exec(head);
  return fromMeta ? fromMeta[1].toLowerCase() : undefined;
}
