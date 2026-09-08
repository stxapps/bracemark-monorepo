import { decodeHtmlEntities } from '../html/entities';
import { normalizeUrl } from '../url/url';
import type { ImportedLink } from './bundle';
import { parseEpoch } from './epoch';

// Netscape Bookmark File parser — the read mirror of export/netscape.ts, and the
// one importer that covers web browsers (Chrome/Firefox/Safari/IE "Export
// bookmarks"), Karakeep, Delicious, Shaarli, Google Bookmarks and Pocket's older
// HTML export alike. (NOT LinkWarden, whose export is JSON only — see
// detect.ts.) The format is "tag soup": browsers emit unclosed <DT>s and stray
// <p>s, real files diverge in casing and attribute order, and Safari writes an
// attribute with no value at all — so this is a regex TOKENIZER over the
// constructs that matter (<H3> folder headers, <DL>/</DL> nesting, <A> links,
// <DD> descriptions), never an HTML parse. One real export per producer sits in
// __fixtures__/netscape, and netscape-exports.spec.ts is where a claim about
// what they contain has to survive contact with the files. No DOMParser on purpose: parsers in this package
// stay platform-agnostic (Expo later), and a DOM walk would be no more tolerant
// of the soup than the token scan.
//
// Nesting: an <H3> names the folder that the NEXT <DL> opens, so the scanner
// holds it as `pendingFolder` until a <DL> consumes it. A <DL> with no pending
// header (the root list) pushes an anonymous scope — null — that contributes
// nothing to folderPath. Unbalanced </DL>s (truncated files) just stop popping.
//
// <DD> is the format's own description element, and the one construct here with
// NO closing tag: the description runs from the tag to the next block one. Our
// exporter never writes it (export/netscape.ts sends notes to CSV instead — see
// export/csv.ts), so it exists purely to read what other apps write, which is
// the whole job of this file. Dropping it silently lost a note per link, and a
// note is the one field a bookmarks file carries that the user TYPED.

// One scan, five alternatives: folder header, link anchor, list open, list close,
// description. [\s\S]*? for inner text because titles can contain newlines; \b
// after the tag name so <address>/<abbr> never match as <a>.
//
// The <DD> arm ends on a LOOKAHEAD at the next block tag rather than at the next
// `<`, so inline markup inside a description (a real file has <b>, <br>, an <a>)
// stays inside the capture for innerText to strip, instead of truncating the
// note at its first tag.
const TOKEN_RE =
  /<h3\b([^>]*)>([\s\S]*?)<\/h3\s*>|<a\b([^>]*)>([\s\S]*?)<\/a\s*>|<dl\b[^>]*>|<\/dl\s*>|<dd\b[^>]*>([\s\S]*?)(?=<dt\b|<dd\b|<dl\b|<\/dl\b|<h3\b|$)/gi;

// One double-quoted attribute out of a tag's attribute text, case-insensitive.
// Netscape files quote every attribute value; unquoted values don't occur.
function attr(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs);
  return match ? match[1] : undefined;
}

// Undo the writer-side esc(), and everything else a real exporter emits: this is
// an HTML format, so a title is HTML-escaped by definition and the reference set
// is the whole of HTML's, not just the five characters WE escape on the way out.
// `decodeHtmlEntities` (html/entities.ts) is shared with the two raw-HTML title
// parsers for exactly that reason — it decodes in ONE pass, so a decoded result is
// never re-scanned (`&#38;lt;` yields the literal `&lt;`, not `<`), and leaves an
// unknown name untouched, which is better than a dropped title. It carried only
// `&amp;`-and-friends when it lived here, so a browser export of
// `Kleppmann&rsquo;s blog` imported with the entity still in it.

// Inner text of a tokenized element → display text: drop any nested markup
// (Firefox can nest e.g. <img> inside anchors), unescape, collapse whitespace.
function innerText(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// The same, for a <DD> description — which is BLOCK text, not a label, so its
// line breaks are content and `innerText`'s collapse would destroy them. Real
// exports carry lists and paragraphs in there (a Shaarli/Delicious description
// is markdown), and a note that reads `List: - item1 - item2 - item3` on one
// line is the shape of having thrown that away. Horizontal whitespace still
// collapses — an export indents its <DD> body to match the surrounding tag soup,
// and that indentation is the file's formatting, not the user's — and a run of
// blank lines folds to one, which is what an HTML block would have rendered.
function descriptionText(value: string): string {
  const lines = decodeHtmlEntities(value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''))
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  // Dedent rather than trim each line. The indentation on lines 2..n is the
  // FILE's (an export indents the <DD> body to match its tag soup), but the
  // indentation RELATIVE to that is the user's — a nested markdown list, which
  // real exports do carry. Removing the common prefix keeps the second and
  // discards the first. Line 1 is exempt because it sits inline after the tag
  // and so has no indentation of its own to compare.
  const indents = lines
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length);
  const common = indents.length > 0 ? Math.min(...indents) : 0;
  return lines
    .map((line, index) => (index === 0 ? line.trim() : line.slice(common)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseNetscapeHtml(text: string): ImportedLink[] {
  const links: ImportedLink[] = [];
  // Open <DL> scopes: a folder name, or null for an anonymous scope (the root
  // list). folderPath is the non-null names, root-first.
  const stack: (string | null)[] = [];
  let pendingFolder: string | null = null;
  // The link a <DD> would describe: set by the anchor arm and cleared by every
  // other token, so a description attaches to the link IMMEDIATELY before it and
  // to nothing else. Without that, `<DT><H3>F</H3><DD>folder note` would land a
  // folder's description on whatever link happened to be parsed last — a note
  // from one folder showing up on a link in another.
  let noteTarget: ImportedLink | undefined;

  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];

    // <dd>description. Checked FIRST, because the <dl> arm below dispatches on
    // the token's second character and `<dd` answers to that test too.
    if (match[5] !== undefined) {
      const note = descriptionText(match[5]);
      if (noteTarget !== undefined && note !== '') noteTarget.note = note;
      noteTarget = undefined;
      continue;
    }

    if (token[1] === '/') {
      // </dl> — close the innermost scope.
      stack.pop();
      pendingFolder = null;
      noteTarget = undefined;
      continue;
    }

    const tag = token[1].toLowerCase();
    if (tag === 'd') {
      // <dl> — opens the pending header's folder, or an anonymous scope.
      stack.push(pendingFolder);
      pendingFolder = null;
      noteTarget = undefined;
      continue;
    }

    if (tag === 'h') {
      const name = innerText(match[2]);
      pendingFolder = name === '' ? null : name;
      noteTarget = undefined;
      continue;
    }

    // <a ...>title</a>
    const attrs = match[3];
    // A dropped row still clears the note target: the <DD> after a bookmarklet
    // describes the bookmarklet, and would otherwise land on the last link kept.
    noteTarget = undefined;
    const href = attr(attrs, 'href');
    if (href === undefined) continue;
    const url = normalizeUrl(decodeHtmlEntities(href));
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
      link.tagNames = decodeHtmlEntities(tags)
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
    noteTarget = link;
  }

  return links;
}
