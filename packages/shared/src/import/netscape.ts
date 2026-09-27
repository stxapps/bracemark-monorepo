import { decodeHtmlEntities } from '../html/entities';
import { normalizeUrl } from '../url/url';
import type { ImportedLink, ImportObserver } from './bundle';
import { parseEpoch } from './epoch';
import { FAVORITES_TAG, isRaindropHtml, withHighlights, withoutUnsorted } from './raindrop';
import { PARSE_CHUNK, runSteps } from './steps';

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
// nothing to folderPath. Unbalanced </DL>s (truncated files) just stop popping,
// and reach an observer as damage (see ImportObserver, bundle.ts).
//
// <DD> is the format's own description element, and the one construct here with
// NO closing tag: the description runs from the tag to the next block one. Our
// app exporter does not write it (export/netscape.ts sends app notes to CSV
// instead — see export/csv.ts); the standalone converter opts in when making
// an HTML file from a CSV. Dropping it silently lost a note per link, and a
// note is the one field a bookmarks file carries that the user TYPED. Raindrop
// writes a link's highlights as MORE <DD>s after the note, each holding one
// <blockquote> — see raindrop.ts for where those go.
//
// The anchor text crosses as `customTitle`, not as a provisional title: a
// browser lets its user rename a bookmark, and nothing in the file says whether
// one did — see ImportedLink.customTitle (bundle.ts).

// One scan, five alternatives: folder header, link anchor, list open, list close,
// description. `.*?` under the `s` flag for inner text, because titles can
// contain newlines; \b after the tag name so <address>/<abbr> never match as <a>.
//
// ⚠ Spelled `.*?` + `s`, never `[\s\S]*?` (or `[^]*?`). They match the same
// characters, but on Hermes a lazy loop over a character CLASS costs time in
// proportion to the rest of the input on every match, so the scan goes
// quadratic in the file's size. A 10,000-link bookmarks file held bracemark-expo's
// JS thread for 31 s; the same scan with `.*?` is linear, and V8 runs every
// spelling alike (docs/data-lifecycle.md, _readings — expo_). Nothing on web
// shows the difference, so lint does: `REGEX_SYNTAX` in eslint.config.mjs
// rejects the any-character lazy spellings workspace-wide.
//
// The <DD> arm ends on a LOOKAHEAD at the next block tag rather than at the next
// `<`, so inline markup inside a description (a real file has <b>, <br>, an <a>)
// stays inside the capture for innerText to strip, instead of truncating the
// note at its first tag.
const TOKEN_RE =
  /<h3\b([^>]*)>(.*?)<\/h3\s*>|<a\b([^>]*)>(.*?)<\/a\s*>|<dl\b[^>]*>|<\/dl\s*>|<dd\b[^>]*>(.*?)(?=<dt\b|<dd\b|<dl\b|<\/dl\b|<h3\b|$)/gis;

// One double-quoted attribute out of a tag's attribute text, case-insensitive.
// Netscape files quote every attribute value; unquoted values don't occur.
//
// Compiled once per NAME, not per call: `attr` runs up to five times per anchor,
// and building the RegExp each time was about 150 ms of a 10,000-link parse on
// Hermes — more than the whole token scan. Non-global, so `exec` keeps no
// `lastIndex` between calls and the shared instance is safe to reuse.
const ATTR_RES = new Map<string, RegExp>();
function attr(attrs: string, name: string): string | undefined {
  let re = ATTR_RES.get(name);
  if (re === undefined) {
    re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');
    ATTR_RES.set(name, re);
  }
  const match = re.exec(attrs);
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

const INCOMPLETE_ENTRY = 'This bookmarks HTML has an incomplete bookmark entry. Export it again.';

export function parseNetscapeHtml(text: string, observer?: ImportObserver): ImportedLink[] {
  return runSteps(parseNetscapeHtmlSteps(text, observer));
}

// The parse as a generator, yielding after every PARSE_CHUNK tokens so an
// orchestrator can hand the thread back between them (steps.ts). The token scan
// resumes where it stopped: `matchAll` holds its own position.
export function* parseNetscapeHtmlSteps(
  text: string,
  observer?: ImportObserver,
): Generator<void, ImportedLink[]> {
  const links: ImportedLink[] = [];
  let tokenCount = 0;
  let position = 0;
  // Open <DL> scopes: a folder name, or null for an anonymous scope (the root
  // list). folderPath is the non-null names, root-first.
  const stack: (string | null)[] = [];
  let pendingFolder: string | null = null;
  const raindrop = isRaindropHtml(text);
  // The link a <DD> would describe: set by the anchor arm and cleared by every
  // other token except another <DD>, so a description attaches to the link
  // IMMEDIATELY before it and to nothing else. Without that,
  // `<DT><H3>F</H3><DD>folder note` would land a folder's description on whatever
  // link happened to be parsed last — a note from one folder showing up on a link
  // in another. A run of <DD>s is one link's: Raindrop writes the note and then
  // one <DD> per highlight.
  let noteTarget: ImportedLink | undefined;
  // Highlights per link, folded into the note once the scan is done — they can
  // arrive before the whole run has been seen, and the note goes first.
  const highlights = new Map<ImportedLink, string[]>();

  // With an observer, the scan also recognizes an anchor with no </a>, so a
  // damaged export cannot quietly lose records outside the normal tokenizer. The
  // one branch on the observer, and it changes what is DETECTED, never which links
  // come out: the extra arm only matches where no full anchor does, and the
  // tolerant path skips such a token. Without an observer nobody would hear about
  // it, so the plain scan keeps TOKEN_RE as is. Reuse TOKEN_RE's own flags:
  // without `s`, a multi-line <DD> fails to match and an <a> inside it is counted
  // as a second bookmark.
  const tokens = observer ? new RegExp(TOKEN_RE.source + '|<a\\b[^>]*>', TOKEN_RE.flags) : TOKEN_RE;
  for (const match of text.matchAll(tokens)) {
    if (tokenCount > 0 && tokenCount % PARSE_CHUNK === 0) yield;
    tokenCount++;
    const token = match[0];

    // <dd>description. Checked FIRST, because the <dl> arm below dispatches on
    // the token's second character and `<dd` answers to that test too.
    if (match[5] !== undefined) {
      if (noteTarget === undefined) continue;
      if (/^\s*<blockquote\b/i.test(match[5])) {
        // A <DD> that IS a <blockquote> is a highlight (Raindrop), not the note.
        const quotes = [...match[5].matchAll(/<blockquote\b[^>]*>(.*?)<\/blockquote\s*>/gis)];
        const list = highlights.get(noteTarget) ?? [];
        for (const quote of quotes) list.push(descriptionText(quote[1]));
        highlights.set(noteTarget, list);
        continue;
      }
      // The first description is the note; no producer writes two, and a second
      // one never replaces what the first said.
      const note = descriptionText(match[5]);
      if (note !== '' && noteTarget.note === undefined) noteTarget.note = note;
      continue;
    }

    if (token[1] === '/') {
      // </dl> — close the innermost scope.
      if (stack.length === 0) {
        observer?.damage('This bookmarks HTML has an unmatched folder ending. Export it again.');
      }
      stack.pop();
      pendingFolder = null;
      noteTarget = undefined;
      continue;
    }

    const tag = token[1].toLowerCase();
    if (tag === 'd') {
      // <dl> — opens the pending header's folder, or an anonymous scope.
      stack.push(pendingFolder);
      if (pendingFolder !== null) {
        const path = stack.filter((name): name is string => name !== null);
        observer?.folder(raindrop ? withoutUnsorted(path) : path);
      }
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
    if (attrs === undefined) {
      // An <a> with no </a> — only the observer's scan has this arm. Nothing to
      // keep, and a <DD> after it describes it, not the link before.
      observer?.damage(INCOMPLETE_ENTRY);
      noteTarget = undefined;
      continue;
    }
    // A truncated anchor that the lazy scan closed at the NEXT entry's </a>,
    // swallowing it. Still kept as one link, as the app always has; guarded on the
    // observer only to spare the plain scan a test per anchor.
    if (observer && /<a\b|<dt\b|<dl\b/i.test(match[4])) observer.damage(INCOMPLETE_ENTRY);
    position++;
    // A dropped row still clears the note target: the <DD> after a bookmarklet
    // describes the bookmarklet, and would otherwise land on the last link kept.
    noteTarget = undefined;
    const href = attr(attrs, 'href');
    if (href === undefined) {
      observer?.row(position, 'No quoted address');
      continue;
    }
    const url = normalizeUrl(decodeHtmlEntities(href));
    // Non-web hrefs (bookmarklets, place:/mailto: rows) aren't storable links.
    if (url === null) {
      observer?.row(position, 'Not a web address');
      continue;
    }
    observer?.row(position);

    const folderPath = stack.filter((name): name is string => name !== null);
    const link: ImportedLink = {
      url,
      tagNames: [],
      folderPath: raindrop ? withoutUnsorted(folderPath) : folderPath,
    };

    const title = innerText(match[4]);
    if (title !== '') link.customTitle = title;

    // TAGS is the de-facto attribute Pocket/Pinboard write and LinkWarden reads
    // (export/netscape.ts writes it too), comma-joined names.
    const tags = attr(attrs, 'tags');
    if (tags !== undefined) {
      link.tagNames = decodeHtmlEntities(tags)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');
    }
    // Raindrop's favorite flag — see FAVORITES_TAG.
    if (attr(attrs, 'data-important') === 'true' && !link.tagNames.includes(FAVORITES_TAG)) {
      link.tagNames.push(FAVORITES_TAG);
    }

    // ADD_DATE is the convention; TIME_ADDED is Pocket's spelling of the same.
    const createdAt = parseEpoch(attr(attrs, 'add_date')) ?? parseEpoch(attr(attrs, 'time_added'));
    if (createdAt !== undefined) link.createdAt = createdAt;
    const updatedAt = parseEpoch(attr(attrs, 'last_modified'));
    if (updatedAt !== undefined) link.updatedAt = updatedAt;

    links.push(link);
    noteTarget = link;
  }

  for (const [link, quotes] of highlights) {
    const note = withHighlights(link.note, quotes);
    if (note !== undefined) link.note = note;
  }
  return links;
}
