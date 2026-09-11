import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeHtmlEntities } from '../html/entities';
import { normalizeUrl } from '../url/url';
import { detectTextImportFormat } from './detect';
import { parseImportText } from './parse';

// Eight REAL bookmark exports, run through the real dispatch — the netscape half
// of what `brace-export.spec.ts` does for Brace.to, and here for the same reason.
//
// `netscape.spec.ts` beside this file covers the parser's rules one at a time
// with hand-written fragments, which is the right shape for rules. What it
// cannot cover is the assumption those fragments are BUILT from: they were
// written by the person who wrote the tokenizer, so they agree with it by
// construction. "Tag soup" is a claim about what browsers emit, and only a file
// a browser emitted can settle it.
//
// The specimens are in `__fixtures__/netscape` (see its README for provenance
// and the MIT notice they are redistributed under), one per producer, VERBATIM —
// never trimmed, anonymized or reformatted, because an edited specimen is a
// hand-written fixture again. They are also the only fixtures here that
// `.prettierignore` protects, for the same reason.
//
// Each case below is a thing a real file taught us, and several were silent
// before we had one to look at: Firefox writes an empty <DD> for every bookmark
// (so "has a description" is not "has a <DD>"), Google Bookmarks dates are
// 16-digit microseconds, Safari writes no dates at all and no root <DL>, Chrome
// buries a base64 favicon in the same tag as the href, and a Shaarli
// description can contain an <a> that is emphatically not a bookmark.
// Assertions are RELATIONS wherever a count would do, so a specimen replaced by
// a newer export of the same producer doesn't invalidate them.
const FIXTURES = join(__dirname, '__fixtures__', 'netscape');
const read = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');

interface Specimen {
  file: string;
  producer: string;
  // What the file actually holds, counted by hand once. A parse that yields
  // FEWER is the interesting failure (a folder that swallowed its siblings, a
  // scan that stopped at the first oddity) and it is invisible without this.
  links: number;
}

const SPECIMENS: Specimen[] = [
  { file: 'chromium_nested.htm', producer: 'Chromium', links: 18 },
  { file: 'firefox_nested.htm', producer: 'Firefox', links: 21 },
  { file: 'internet_explorer_11_nested.htm', producer: 'Internet Explorer 11', links: 27 },
  { file: 'safari_folded.htm', producer: 'Safari', links: 3 },
  { file: 'google_bookmarks_nested.htm', producer: 'Google Bookmarks', links: 6 },
  { file: 'delicious.htm', producer: 'Delicious', links: 5 },
  { file: 'netscape_multiline.htm', producer: 'Shaarli (multi-line notes)', links: 3 },
  { file: 'netscape_extended.htm', producer: 'Shaarli (thumbnail in a note)', links: 1 },
];

describe('real Netscape exports, as their producers wrote them', () => {
  // The whole-file invariant, one case for all eight: the parser routes the file
  // by structure and yields rows the FILE declares — never a row it invented,
  // never a non-web href, never fewer than the file holds.
  it.each(SPECIMENS)(
    '$producer: is routed by content and yields what it declares',
    ({ file, links: expected }) => {
      const text = read(file);
      expect(detectTextImportFormat(text, file)).toBe('netscape');

      const bundle = parseImportText(text, file);
      expect(bundle.links).toHaveLength(expected);
      // No interop format carries bytes; only a Brace.to export does.
      expect(bundle.images.size).toBe(0);

      // Every href in the file, normalized the same way the parser normalizes, so
      // set membership is exact. A parsed URL outside this set would be one the
      // parser assembled rather than read — the failure a URL-mining misroute
      // produces, and the one this whole file exists to make loud.
      const declared = new Set(
        [...text.matchAll(/href\s*=\s*"([^"]*)"/gi)]
          .map((match) => normalizeUrl(decodeHtmlEntities(match[1])))
          .filter((url): url is string => url !== null),
      );
      for (const link of bundle.links) {
        expect(declared.has(link.url)).toBe(true);
        expect(link.url).toMatch(/^https?:\/\//);
      }
    },
  );

  // Chrome's export wraps the bar in a folder whose NAME is ordinary and whose
  // marker is an attribute; the row also carries a base64 favicon in the same
  // tag as the href, which is the biggest thing in the file by an order of
  // magnitude and the easiest to leak into a title or a URL.
  it('Chromium: the bookmarks bar is a folder, and the inline favicon stays out of the row', () => {
    const { links } = parseImportText(read('chromium_nested.htm'), 'chromium_nested.htm');
    const paths = links.map((link) => link.folderPath.join('/'));

    expect(paths).toContain('Personal toolbar');
    // Nesting is real in this file, so a scanner that never pushed a scope would
    // still pass every count above and fail here.
    expect(paths).toContain('Dev/PHP');
    // PERSONAL_TOOLBAR_FOLDER="true" is an attribute, not a name.
    for (const path of paths) expect(path).not.toContain('true');
    for (const link of links) {
      expect(link.url).not.toContain('base64');
      expect(link.customTitle ?? '').not.toContain('base64');
    }
  });

  // Two Firefox facts, both invisible in a hand-written fragment. The `place:`
  // rows are its saved queries — "Most Visited", "Recently Bookmarked" — which
  // are not links and would import as broken ones; and it writes a <DD> for
  // EVERY bookmark, empty when there is no description, so counting <DD>s is not
  // counting notes.
  it('Firefox: place: queries are dropped, and an empty <DD> is not a note', () => {
    const text = read('firefox_nested.htm');
    const { links } = parseImportText(text, 'firefox_nested.htm');

    expect(text.match(/href="place:/gi)).toHaveLength(3);
    for (const link of links) expect(link.url).not.toContain('place:');

    const dds = text.match(/<dd\b/gi) ?? [];
    const notes = links.filter((link) => link.note !== undefined);
    expect(dds.length).toBeGreaterThan(notes.length * 2);
    expect(notes.length).toBeGreaterThan(0);
    for (const link of notes) expect(link.note).not.toBe('');
    // TAGS is Firefox's too, and the file is mostly tagged — a tokenizer that
    // lost the attribute would still pass every count above.
    expect(links.filter((link) => link.tagNames.length > 0).length).toBeGreaterThan(15);
  });

  // Safari's file is the format at its loosest: no root <DL> before the first
  // folder, a VALUELESS `FOLDED` attribute on every <H3>, and not one date in
  // the file. The valueless attribute is the trap — an attribute scanner that
  // expects `name="value"` can run off the end of the tag.
  it('Safari: a valueless FOLDED attribute still names a folder, and no row invents a date', () => {
    const { links } = parseImportText(read('safari_folded.htm'), 'safari_folded.htm');

    expect(links.map((link) => link.folderPath)).toEqual([
      ['Favoris'],
      ['Github - Shaarli'],
      ['Autre Divers', 'doc'],
    ]);
    for (const link of links) {
      expect(link.createdAt).toBeUndefined();
      expect(link.updatedAt).toBeUndefined();
    }
  });

  // 16-digit ADD_DATE values. Read as seconds they land ~50 million years out;
  // read as milliseconds, ~48 000 years. Either way the row sorts to the end of
  // the library forever and nothing errors — magnitude detection (epoch.ts) is
  // the only thing between this file and that.
  it('Google Bookmarks: microsecond dates land in the century they were written in', () => {
    const { links } = parseImportText(
      read('google_bookmarks_nested.htm'),
      'google_bookmarks_nested.htm',
    );

    for (const link of links) {
      expect(link.createdAt).toBeDefined();
      const year = new Date(link.createdAt ?? 0).getUTCFullYear();
      expect(year).toBeGreaterThanOrEqual(2015);
      expect(year).toBeLessThanOrEqual(2025);
    }
  });

  // A service export rather than a browser's: every row carries both TAGS and a
  // <DD>, which is the pairing our own HTML export cannot produce (notes ride
  // the CSV) and therefore the one no round-trip case covers.
  it('Delicious: tags and descriptions both cross', () => {
    const { links } = parseImportText(read('delicious.htm'), 'delicious.htm');

    expect(links.filter((link) => link.tagNames.length > 0)).toHaveLength(links.length);
    const notes = links.filter((link) => link.note !== undefined);
    expect(notes.length).toBeGreaterThanOrEqual(4);
    for (const link of notes) expect(link.note).not.toMatch(/^\s|\s$/);
  });

  // The specimen that decided how a description is normalized. A <DD> is BLOCK
  // text: these are markdown lists and paragraphs, and collapsing them to one
  // line — which is right for a title — turns a note into a run-on sentence.
  it('Shaarli: a multi-line description keeps its lines, its blank line and its nesting', () => {
    const { links } = parseImportText(read('netscape_multiline.htm'), 'netscape_multiline.htm');

    expect(links[0].note).toBe('List:\n- item1\n- item2\n- item3');
    // The indent here is the USER's (a nested list), unlike the indent an export
    // adds to its own tag soup, which comes off.
    expect(links[1].note).toBe(
      'Nested lists:\n- list1\n  - item1.1\n  - item1.2\n  - item1.3\n- list2\n  - item2.1',
    );
    expect(links[2].note).toBe(
      'List:\n- item1\n- item2\n\nParagraph number one.\n\nParagraph\nnumber\ntwo.',
    );
  });

  // The file that proves the <DD> boundary matters. Shaarli puts a thumbnail
  // <a><img></a> INSIDE the description, pointing at its own local instance —
  // parsed as a bookmark it becomes a `localhost:8083` row in the user's
  // library, imported once per illustrated link and dead on arrival.
  it('Shaarli: an anchor inside a description is not a bookmark', () => {
    const text = read('netscape_extended.htm');
    const { links } = parseImportText(text, 'netscape_extended.htm');

    expect(text).toContain('<img src=');
    expect(text.match(/<a\s[^>]*href=/gi)).toHaveLength(2);
    expect(links).toHaveLength(1);
    expect(links[0].url).toContain('bbc.com');
    expect(links[0].note).toContain('rogue fishing vessel');
    // …and the description it sat in still crossed whole.
    expect(links[0].note).toMatch(/^For 10 years/);
  });
});
