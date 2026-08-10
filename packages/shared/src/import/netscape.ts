import { normalizeUrl } from '../url/url';
import type { ImportedLink } from './bundle';
import { parseEpoch } from './epoch';

// Netscape Bookmark File parser — the read mirror of export/netscape.ts, and the
// one importer that covers web browsers (Chrome/Firefox/Safari "Export
// bookmarks"), Karakeep, LinkWarden, and Pocket exports alike. The format is
// "tag soup": browsers emit unclosed <DT>s and stray <p>s, and real-world files
// diverge in casing and attribute order — so this is a regex TOKENIZER over the
// four constructs that matter (<H3> folder headers, <DL>/</DL> nesting, <A>
// links), never an HTML parse. No DOMParser on purpose: parsers in this package
// stay platform-agnostic (Expo later), and a DOM walk would be no more tolerant
// of the soup than the token scan.
//
// Nesting: an <H3> names the folder that the NEXT <DL> opens, so the scanner
// holds it as `pendingFolder` until a <DL> consumes it. A <DL> with no pending
// header (the root list) pushes an anonymous scope — null — that contributes
// nothing to folderPath. Unbalanced </DL>s (truncated files) just stop popping.

// One scan, four alternatives: folder header, link anchor, list open, list close.
// [\s\S]*? for inner text because titles can contain newlines; \b after the tag
// name so <address>/<abbr> never match as <a>.
const TOKEN_RE =
  /<h3\b([^>]*)>([\s\S]*?)<\/h3\s*>|<a\b([^>]*)>([\s\S]*?)<\/a\s*>|<dl\b[^>]*>|<\/dl\s*>/gi;

// One double-quoted attribute out of a tag's attribute text, case-insensitive.
// Netscape files quote every attribute value; unquoted values don't occur.
function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs);
  return match ? match[1] : undefined;
}

// Undo the writer-side esc() (the predefined entities) plus the numeric forms
// and &nbsp; that other exporters emit. ONE pass over the source, so a decoded
// result is never re-scanned (`&#38;lt;` yields the literal `&lt;`, not `<`).
// Unknown named entities pass through untouched — better a literal `&eacute;`
// than a dropped title.
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function unescapeHtml(value: string): string {
  return value.replace(ENTITY_RE, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// Inner text of a tokenized element → display text: drop any nested markup
// (Firefox can nest e.g. <img> inside anchors), unescape, collapse whitespace.
function innerText(value: string): string {
  return unescapeHtml(value.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseNetscapeHtml(text: string): ImportedLink[] {
  const links: ImportedLink[] = [];
  // Open <DL> scopes: a folder name, or null for an anonymous scope (the root
  // list). folderPath is the non-null names, root-first.
  const stack: (string | null)[] = [];
  let pendingFolder: string | null = null;

  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];

    if (token[1] === '/') {
      // </dl> — close the innermost scope.
      stack.pop();
      pendingFolder = null;
      continue;
    }

    const tag = token[1].toLowerCase();
    if (tag === 'd') {
      // <dl> — opens the pending header's folder, or an anonymous scope.
      stack.push(pendingFolder);
      pendingFolder = null;
      continue;
    }

    if (tag === 'h') {
      const name = innerText(match[2]);
      pendingFolder = name === '' ? null : name;
      continue;
    }

    // <a ...>title</a>
    const attrs = match[3];
    const href = attr(attrs, 'href');
    if (href === undefined) continue;
    const url = normalizeUrl(unescapeHtml(href));
    // Non-web hrefs (bookmarklets, place:/mailto: rows) aren't storable links.
    if (url === null) continue;

    const link: ImportedLink = {
      url,
      tagNames: [],
      folderPath: stack.filter((name): name is string => name !== null),
    };

    const title = innerText(match[4]);
    if (title !== '') link.title = title;

    // TAGS is the de-facto attribute Pocket/Pinboard write and LinkWarden reads
    // (export/netscape.ts writes it too), comma-joined names.
    const tags = attr(attrs, 'tags');
    if (tags !== undefined) {
      link.tagNames = unescapeHtml(tags)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
    }

    // ADD_DATE is the convention; TIME_ADDED is Pocket's spelling of the same.
    const createdAt = parseEpoch(attr(attrs, 'add_date')) ?? parseEpoch(attr(attrs, 'time_added'));
    if (createdAt !== undefined) link.createdAt = createdAt;
    const updatedAt = parseEpoch(attr(attrs, 'last_modified'));
    if (updatedAt !== undefined) link.updatedAt = updatedAt;

    links.push(link);
  }

  return links;
}
