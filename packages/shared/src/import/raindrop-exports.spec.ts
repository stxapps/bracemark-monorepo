import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeHtmlEntities } from '../html/entities';
import type { Link } from '../sync/entities';
import { EXTRACTIONS_PREFIX, LINKS_PREFIX } from '../sync/paths';
import { MY_LIST_ID } from '../sync/system-lists';
import { normalizeUrl } from '../url/url';
import type { ImportedLink } from './bundle';
import { detectTextImportFormat } from './detect';
import { parseImportText } from './parse';
import { projectImportedLinks } from './project';
import { FAVORITES_TAG } from './raindrop';

// One REAL Raindrop.io library, exported both ways Raindrop offers, run through
// the real dispatch — the Raindrop half of what `netscape-exports.spec.ts` does
// for browsers, and here for the same reason: `csv.spec.ts` and
// `netscape.spec.ts` cover the rules with hand-written rows, which agree with the
// parsers by construction.
//
// Having BOTH files of one library at one moment buys a claim no single specimen
// can make: they describe the same links, so they must import to the same rows.
// Most of what Raindrop does differently between the two — `&quot;` against
// `""`, tags joined `a,b` against `a, b`, a note in a <DD> against a quoted cell,
// highlights as <blockquote>s against a `Highlight:` column — is held by that
// one relation rather than a case each. The specimens and what went into them:
// `__fixtures__/raindrop/README.md`.
const FIXTURES = join(__dirname, '__fixtures__', 'raindrop');
const HTML = readFileSync(join(FIXTURES, 'raindrop.html'), 'utf8');
const CSV = readFileSync(join(FIXTURES, 'raindrop.csv'), 'utf8');

const html = parseImportText(HTML, 'raindrop.html').links;
const csv = parseImportText(CSV, 'raindrop.csv').links;

// Counted by hand once. Fewer is the interesting failure — a folder that
// swallowed its siblings, a note that ran on into the next link.
const LINKS = 19;

const byUrl = (links: ImportedLink[], url: string) => links.find((link) => link.url === url);

describe('a real Raindrop.io export, HTML and CSV', () => {
  // Both files route by content, yield every link they hold and only those. The
  // HTML's <head> carries a stylesheet <link href="data:…">, which is not a
  // bookmark; the https check is what would catch it.
  it('is routed by content and yields what each file declares', () => {
    expect(detectTextImportFormat(HTML, 'raindrop.html')).toBe('netscape');
    expect(detectTextImportFormat(CSV, 'raindrop.csv')).toBe('csv');
    expect(html).toHaveLength(LINKS);
    expect(csv).toHaveLength(LINKS);

    const declared = new Set(
      [...HTML.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)].map((match) =>
        normalizeUrl(decodeHtmlEntities(match[1])),
      ),
    );
    for (const link of [...html, ...csv]) {
      expect(declared.has(link.url)).toBe(true);
      expect(link.url).toMatch(/^https?:\/\//);
    }
  });

  // THE relation. Same links in the same order, and every field either file
  // carries agrees — except two things only one side has: the HTML's
  // LAST_MODIFIED, and the CSV's milliseconds.
  it('imports the same library from either file', () => {
    expect(csv.map((link) => link.url)).toEqual(html.map((link) => link.url));

    html.forEach((fromHtml, index) => {
      const fromCsv = csv[index];
      expect(fromCsv.customTitle).toBe(fromHtml.customTitle);
      expect(fromCsv.note).toBe(fromHtml.note);
      expect(fromCsv.tagNames).toEqual(fromHtml.tagNames);
      expect(fromCsv.systemList).toBe(fromHtml.systemList);
      expect(Math.floor((fromCsv.createdAt ?? 0) / 1000) * 1000).toBe(fromHtml.createdAt);
      expect(fromHtml.updatedAt).toBeDefined();
      expect(fromCsv.updatedAt).toBeUndefined();
    });
  });

  // …and the one place they can't agree, pinned so it stays the ONLY one. The CSV
  // joins a collection path with ` / ` and doesn't escape a name that contains
  // it, so `SEO / AEO` reads as two lists there and one in the HTML. A name with
  // a bare slash, `AEO/GEO`, survives both — which is why the Raindrop CSV is
  // split on the padded separator and nothing else.
  it('disagrees only where a collection name contains the CSV’s separator', () => {
    const differing = html
      .map((fromHtml, index) => [fromHtml.folderPath, csv[index].folderPath])
      .filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b));
    expect(differing).toEqual([
      [
        ['Marketing', 'SEO / AEO', 'Search Engines', 'Google'],
        ['Marketing', 'SEO', 'AEO', 'Search Engines', 'Google'],
      ],
    ]);
    expect(html.map((link) => link.folderPath)).toContainEqual(['Marketing', 'AEO/GEO']);
    expect(html.map((link) => link.folderPath)).toContainEqual(['books', 'draw & paint']);
  });

  // Unsorted is Raindrop's inbox, written as a top-level folder of that name. It
  // crosses as the default list — no folder at all — never as a list called
  // Unsorted. Four links sit in it.
  it('lands Unsorted in the default list', () => {
    for (const links of [html, csv]) {
      expect(links.filter((link) => link.folderPath.length === 0)).toHaveLength(4);
      for (const link of links) expect(link.folderPath).not.toContain('Unsorted');
    }
  });

  // A link here has one note, so highlights fold into it as `> ` quotes, AFTER
  // whatever the user typed. The HTML writes the note's <DD> first and a <DD> per
  // highlight after it; before this, the first <DD> won and every highlight was
  // dropped — or, on a link with no note, the first highlight became the note.
  it('folds highlights into the note, the typed note first', () => {
    for (const links of [html, csv]) {
      const both = byUrl(links, 'https://contentshifu.com/')?.note ?? '';
      expect(both).toMatch(
        /^This one has both note and highlight!\n\nLet's see how it turns out\./,
      );
      expect(both).toContain('\n\n> Marketing & Technology\n\n> Gemini 3.5 Transcribe');

      const onlyHighlights = links.find((link) => link.note?.startsWith('> A World Without Soil'));
      expect(onlyHighlights?.note).toMatch(/^> A World Without Soil\n\n> This book by/);
    }
  });

  // A favorite crosses as a tag, on exactly the rows the file flags.
  it('tags exactly the favorites', () => {
    const flagged = HTML.match(/DATA-IMPORTANT="true"/g) ?? [];
    expect(flagged.length).toBeGreaterThan(0);
    for (const links of [html, csv]) {
      const tagged = links.filter((link) => link.tagNames.includes(FAVORITES_TAG));
      expect(tagged).toHaveLength(flagged.length);
    }
  });

  // The specimen that moved the title rule. `JRO Tools Youtube Tutorial` is a
  // name the user typed in Raindrop (the page calls itself something else — see
  // the CSV's `excerpt`), and neither file marks it as typed. So every title
  // crosses as customTitle, and the projection writes no extraction for it:
  // that absence is what leaves the link pending for our extractor, which can
  // then only fill in UNDER the name, never replace it.
  it('keeps a renamed title where extraction can’t overwrite it', () => {
    for (const links of [html, csv]) {
      for (const link of links) {
        expect(link.customTitle).toBeDefined();
        expect(link.title).toBeUndefined();
      }
    }

    let n = 0;
    const result = projectImportedLinks({
      rows: html,
      lists: [],
      tags: [],
      existingPinRanks: [],
      images: new Map(),
      newId: () => `new-${++n}`,
      now: 1_800_000_000_000,
    });
    const links = result.entries
      .filter((entry) => entry.path.startsWith(LINKS_PREFIX))
      .map((entry) => entry.data as Link);
    const renamed = links.find(
      (link) => link.url === 'https://www.youtube.com/watch?v=ip-PMjsKVX8',
    );
    expect(renamed?.customTitle).toBe('JRO Tools Youtube Tutorial');
    expect(result.entries.filter((entry) => entry.path.startsWith(EXTRACTIONS_PREFIX))).toEqual([]);
    // …and Unsorted, end to end, is the default list itself.
    expect(links.filter((link) => link.listId === MY_LIST_ID)).toHaveLength(4);
  });
});
