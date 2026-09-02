import { toNetscapeHtml } from '../export/netscape';
import { parseNetscapeHtml } from './netscape';

describe('parseNetscapeHtml', () => {
  it('parses a browser-style file: nesting, dates, tags, root links', () => {
    const html = [
      '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
      '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
      '<TITLE>Bookmarks</TITLE>',
      '<H1>Bookmarks</H1>',
      '<DL><p>',
      '    <DT><A HREF="https://root.example.com/" ADD_DATE="1700000000">Root link</A>',
      '    <DT><H3 ADD_DATE="1700000000">Work</H3>',
      '    <DL><p>',
      '        <DT><A HREF="https://example.com/a" ADD_DATE="1700000000" LAST_MODIFIED="1700000001" TAGS="dev,read later">A</A>',
      '        <DT><H3>Projects</H3>',
      '        <DL><p>',
      '            <DT><A HREF="https://example.com/b">B</A>',
      '        </DL><p>',
      '    </DL><p>',
      '</DL><p>',
    ].join('\n');

    const links = parseNetscapeHtml(html);
    expect(links).toEqual([
      {
        url: 'https://root.example.com/',
        title: 'Root link',
        tagNames: [],
        folderPath: [],
        createdAt: 1_700_000_000_000,
      },
      {
        url: 'https://example.com/a',
        title: 'A',
        tagNames: ['dev', 'read later'],
        folderPath: ['Work'],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000,
      },
      {
        url: 'https://example.com/b',
        title: 'B',
        tagNames: [],
        folderPath: ['Work', 'Projects'],
      },
    ]);
  });

  it('round-trips its own exporter output', () => {
    const html = toNetscapeHtml({
      folders: [
        {
          name: 'Parent',
          links: [
            {
              url: 'https://example.com/?a=1&b="2"',
              title: 'A <i>&</i> B',
              tagNames: ['<t>', 'plain'],
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_001_000,
            },
          ],
          children: [
            {
              name: 'Child & Co',
              links: [
                {
                  url: 'https://example.com/c',
                  title: 'C',
                  tagNames: [],
                  createdAt: 1_700_000_002_000,
                  updatedAt: 1_700_000_003_000,
                },
              ],
              children: [],
            },
          ],
        },
      ],
      exportedAt: 1_700_000_004_000,
    });

    expect(parseNetscapeHtml(html)).toEqual([
      {
        url: 'https://example.com/?a=1&b="2"',
        title: 'A <i>&</i> B',
        tagNames: ['<t>', 'plain'],
        folderPath: ['Parent'],
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000,
      },
      {
        url: 'https://example.com/c',
        title: 'C',
        tagNames: [],
        folderPath: ['Parent', 'Child & Co'],
        createdAt: 1_700_000_002_000,
        updatedAt: 1_700_000_003_000,
      },
    ]);
  });

  it('skips non-web hrefs (bookmarklets, place: rows) and anchors without href', () => {
    const html = [
      '<DL><p>',
      '<DT><A HREF="javascript:void(0)">Bookmarklet</A>',
      '<DT><A HREF="place:sort=8&maxResults=10">Most Visited</A>',
      '<DT><A>No href</A>',
      '<DT><A HREF="https://example.com/ok">OK</A>',
      '</DL><p>',
    ].join('\n');
    expect(parseNetscapeHtml(html).map((l) => l.url)).toEqual(['https://example.com/ok']);
  });

  it('tolerates missing doctype, unclosed lists, and case soup', () => {
    const html = '<dl><dt><h3>f</h3><dl><DT><a href="https://example.com/x">X</a>';
    expect(parseNetscapeHtml(html)).toEqual([
      { url: 'https://example.com/x', title: 'X', tagNames: [], folderPath: ['f'] },
    ]);
  });

  // Every existing case puts its links BEFORE any </DL>, so nothing here exercised
  // the pop — a scanner that never closed a scope passed the whole file.
  it('closes a folder at </DL>, so the next one is a sibling and not a child', () => {
    const html = [
      '<DL><p>',
      '    <DT><H3>Work</H3>',
      '    <DL><p>',
      '        <DT><A HREF="https://example.com/w">W</A>',
      '    </DL><p>',
      '    <DT><H3>Personal</H3>',
      '    <DL><p>',
      '        <DT><A HREF="https://example.com/p">P</A>',
      '    </DL><p>',
      '    <DT><A HREF="https://example.com/root">R</A>',
      '</DL><p>',
    ].join('\n');

    expect(parseNetscapeHtml(html).map((l) => l.folderPath)).toEqual([['Work'], ['Personal'], []]);
  });

  it('stops popping on an unbalanced </DL> instead of going negative', () => {
    // A truncated or hand-edited file (this file's header names the case): the
    // extra close must leave the scanner at the root, still importing.
    const html = [
      '<DL><p><DT><H3>A</H3><DL><p>',
      '<DT><A HREF="https://example.com/a">A</A>',
      '</DL><p></DL><p></DL><p>',
      '<DT><A HREF="https://example.com/b">B</A>',
    ].join('\n');

    expect(parseNetscapeHtml(html).map((l) => l.folderPath)).toEqual([['A'], []]);
  });

  it('gives an unnamed folder header no folder at all', () => {
    // `<H3></H3>` opens an ANONYMOUS scope — a list named '' is not a thing the
    // resolver should ever be asked to find or create.
    const html = '<DL><p><DT><H3>  </H3><DL><p><DT><A HREF="https://example.com/a">A</A>';
    expect(parseNetscapeHtml(html)[0].folderPath).toEqual([]);
  });

  it('normalizes second/millisecond/microsecond timestamps to ms', () => {
    const html = [
      '<DL><p>',
      '<DT><A HREF="https://example.com/s" ADD_DATE="1700000000">s</A>',
      '<DT><A HREF="https://example.com/ms" ADD_DATE="1700000000000">ms</A>',
      '<DT><A HREF="https://example.com/us" ADD_DATE="1700000000000000">us</A>',
      '<DT><A HREF="https://example.com/pocket" TIME_ADDED="1700000000">pocket</A>',
      '<DT><A HREF="https://example.com/bad" ADD_DATE="not-a-date">bad</A>',
      '</DL><p>',
    ].join('\n');
    const byUrl = new Map(parseNetscapeHtml(html).map((l) => [l.url, l.createdAt]));
    expect(byUrl.get('https://example.com/s')).toBe(1_700_000_000_000);
    expect(byUrl.get('https://example.com/ms')).toBe(1_700_000_000_000);
    expect(byUrl.get('https://example.com/us')).toBe(1_700_000_000_000);
    expect(byUrl.get('https://example.com/pocket')).toBe(1_700_000_000_000);
    expect(byUrl.get('https://example.com/bad')).toBeUndefined();
  });

  it('strips nested markup and decodes entities in titles and folder names', () => {
    const html = [
      '<DL><p>',
      '<DT><H3>Caf&eacute;&#233; &amp; more</H3>',
      '<DL><p>',
      '<DT><A HREF="https://example.com/a">Read&nbsp;<EM>this</EM> &#x26; that</A>',
      '</DL><p>',
      '</DL><p>',
    ].join('\n');
    const [link] = parseNetscapeHtml(html);
    expect(link.title).toBe('Read this & that');
    // Named and numeric spellings of the same character both decode — the table is
    // shared with the extraction parsers (html/entities.ts), so an exporter's
    // `&eacute;` lands as the character a browser would have shown.
    expect(link.folderPath).toEqual(['Caféé & more']);
  });

  // The bug the shared table fixed: the local one held six names, so every
  // typographic entity a browser writes survived into the imported title.
  it('decodes the typographic entities a browser export actually writes', () => {
    const html =
      '<DT><A HREF="https://example.com/a">' +
      'Please stop &mdash; Martin Kleppmann&rsquo;s blog&hellip;</A>';
    expect(parseNetscapeHtml(html)[0].title).toBe('Please stop — Martin Kleppmann’s blog…');
  });

  it('leaves an unknown named entity literal rather than dropping the title', () => {
    const html = '<DT><A HREF="https://example.com/a">a &bogus; b</A>';
    expect(parseNetscapeHtml(html)[0].title).toBe('a &bogus; b');
  });

  it('decodes entities in the href and TAGS attributes too', () => {
    const html = '<DT><A HREF="https://example.com/s?a=1&amp;b=2" TAGS="caf&eacute;,r&amp;d">T</A>';
    const [link] = parseNetscapeHtml(html);
    expect(link.url).toBe('https://example.com/s?a=1&b=2');
    expect(link.tagNames).toEqual(['café', 'r&d']);
  });
});
