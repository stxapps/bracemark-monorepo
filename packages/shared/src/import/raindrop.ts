// What a Raindrop.io export says that neither of the formats it writes has a
// standard place for, read the same way by both parsers — netscape.ts for its
// HTML and csv.ts for its CSV — so the two files of one library import to the
// same rows. Every rule here was read off a real export, not off Raindrop's docs
// (__fixtures__/raindrop, and raindrop-exports.spec.ts, which holds the two files
// to each other). What Raindrop leaves out entirely: Trash — a trashed link is in
// neither file, so nothing here maps it.

// A Raindrop favorite (`DATA-IMPORTANT="true"` in the HTML, `favorite` = `true`
// in the CSV) crosses as this tag. A tag and not a pin, because a pin here is a
// short ORDERED shelf and a Raindrop library can hold hundreds of favorites with
// no order at all. Tags resolve by name, so a second import — or an existing
// tag of the same name — joins it rather than minting another.
export const FAVORITES_TAG = 'Favorites';

// The producer's own name for the file, in its <TITLE>. Only a Raindrop file
// gets the Unsorted rule below: a Chrome folder called "Unsorted" is a folder
// the user made.
export function isRaindropHtml(text: string): boolean {
  return /<title>\s*Raindrop\.io Bookmarks\s*<\/title>/i.test(text.slice(0, 4096));
}

// Raindrop's CSV header carries columns no other producer writes (id, excerpt,
// cover, highlights, favorite); `excerpt` is the one this keys on. Our own CSV
// export doesn't have it, and neither does a hand-made file in the `a/b/c` shape
// Raindrop's IMPORT docs describe — which is the point, because those two join a
// folder path with a bare `/` and Raindrop's export doesn't (see csv.ts).
export function isRaindropCsvHeader(header: string[]): boolean {
  return header.includes('excerpt');
}

// Unsorted is Raindrop's inbox — a system collection every account has, which
// both formats write as a top-level folder of that name. Its counterpart here is
// the default list, so its rows cross with no folder at all rather than minting
// a list called Unsorted beside it. Matched by NAME in both formats: the CSV
// carries nothing else, and also reading the HTML's zero dates would let the two
// files of one library disagree. The cost is a collection a user named Unsorted
// themselves, which lands in the default list too.
export function withoutUnsorted(folderPath: string[]): string[] {
  return folderPath.length === 1 && folderPath[0] === 'Unsorted' ? [] : folderPath;
}

// The CSV's `highlights` cell: each highlight prefixed `Highlight:` and separated
// by a blank line. Split only at a prefix that starts a line, so a highlight that
// itself spans paragraphs stays whole.
export function csvHighlights(cell: string): string[] {
  return cell
    .split(/^Highlight:/m)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

// A link here has one note, and a highlight is text the user chose to keep — so
// highlights are folded into the note rather than dropped, each as a `> ` quote.
// The user's own note goes FIRST: the projection truncates at LINK_NOTE_MAX, and
// what that cuts should be the page's words, not theirs. Both parsers call this
// with the same inputs, which is what makes the HTML and the CSV of one library
// land the same note.
export function withHighlights(note: string | undefined, highlights: string[]): string | undefined {
  const quotes = highlights
    .map((text) => text.replace(/\r\n?/g, '\n').trim())
    .filter((text) => text !== '')
    .map((text) =>
      text
        .split('\n')
        .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
        .join('\n'),
    );
  const parts = note !== undefined && note !== '' ? [note, ...quotes] : quotes;
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
