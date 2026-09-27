import { toRaindropCsv } from '../export/csv';
import { parseRaindropCsv, scanCsv } from './csv';

describe('parseRaindropCsv', () => {
  it('parses a real Raindrop-style export: extra columns, any order', () => {
    // Raindrop's export joins a nested collection with a PADDED slash, which is
    // the only separator a file with its header is split on (see the case below).
    const csv = [
      'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite',
      '1,Example,"my note",page excerpt,https://example.com/a,Work / Projects,"dev, read later",2023-11-14T22:13:20.000Z,,,false',
      '2,,,,https://example.com/b,,,,,,',
    ].join('\r\n');

    expect(parseRaindropCsv(csv)).toEqual([
      {
        url: 'https://example.com/a',
        customTitle: 'Example',
        note: 'my note',
        tagNames: ['dev', 'read later'],
        folderPath: ['Work', 'Projects'],
        createdAt: 1_700_000_000_000,
      },
      { url: 'https://example.com/b', tagNames: [], folderPath: [] },
    ]);
  });

  it('round-trips its own exporter output', () => {
    const csv = toRaindropCsv({
      folders: [
        {
          name: 'Parent',
          links: [
            {
              url: 'https://example.com/a?x=1,2',
              title: 'Quotes " and, commas',
              note: 'line one\nline two',
              tagNames: ['dev', 'read later'],
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_001_000,
            },
          ],
          children: [
            {
              name: 'Child',
              links: [
                {
                  url: 'https://example.com/b',
                  title: 'B',
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

    expect(parseRaindropCsv(csv)).toEqual([
      {
        url: 'https://example.com/a?x=1,2',
        customTitle: 'Quotes " and, commas',
        note: 'line one\nline two',
        tagNames: ['dev', 'read later'],
        folderPath: ['Parent'],
        createdAt: 1_700_000_000_000,
      },
      {
        url: 'https://example.com/b',
        customTitle: 'B',
        tagNames: [],
        folderPath: ['Parent', 'Child'],
        createdAt: 1_700_000_002_000,
      },
    ]);
  });

  it('parses a Pocket shutdown export: time_added epoch seconds, pipe-separated tags', () => {
    const csv = [
      'title,url,time_added,tags,status',
      'Example,https://example.com/a,1700000000,"cooking|recipes",unread',
      'Old read,https://example.com/b,1500000000,,archive',
    ].join('\n');

    expect(parseRaindropCsv(csv)).toEqual([
      {
        url: 'https://example.com/a',
        customTitle: 'Example',
        tagNames: ['cooking', 'recipes'],
        folderPath: [],
        createdAt: 1_700_000_000_000,
      },
      {
        url: 'https://example.com/b',
        customTitle: 'Old read',
        tagNames: [],
        folderPath: [],
        createdAt: 1_500_000_000_000,
        // `archive` is a LIST, not a tag and not a folder: a Pocket library is
        // mostly archive, so reading this column as nothing tipped years of read
        // items into the main list alongside the unread ones.
        systemList: 'archive',
      },
    ]);
  });

  // A second real Pocket header, from the same exporter: some files carry a
  // `cursor` column between `time_added` and `tags` (go-shiori/shiori keeps one
  // of each in its testdata, which is how we know the variant exists). Nothing
  // here reads `cursor`; the point is that a column we don't know about cannot
  // shift the ones we do — the failure a positional parser has and a
  // header-driven one is immune to, which is worth pinning rather than assuming.
  it("ignores an unknown column between the ones it reads (Pocket's `cursor`)", () => {
    const csv = [
      'title,url,time_added,cursor,tags,status',
      'Shiori,https://github.com/go-shiori/shiori,1541343937,,shiori,unread',
    ].join('\n');

    expect(parseRaindropCsv(csv)).toEqual([
      {
        url: 'https://github.com/go-shiori/shiori',
        customTitle: 'Shiori',
        tagNames: ['shiori'],
        folderPath: [],
        createdAt: 1_541_343_937_000,
      },
    ]);
  });

  it('files an unknown status as a normal link rather than guessing a list', () => {
    const csv = [
      'title,url,time_added,tags,status',
      'A,https://example.com/a,1700000000,,unread',
      'B,https://example.com/b,1700000000,,some-future-value',
      'C,https://example.com/c,1700000000,,trash',
    ].join('\n');

    // `trash` included on purpose: it is the value nobody writes and the one a
    // wrong guess would be worst at — a live link filed as deleted.
    expect(parseRaindropCsv(csv).map((link) => link.systemList)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  // A CSV that ISN'T Raindrop's export — ours, or a hand-made file in the `a/b/c`
  // shape Raindrop's import docs describe — joins a path with a bare slash, and
  // may pad it. Both have to read as the same two-segment path: a segment named
  // ` Job Search` would find no existing list and mint a second one beside the
  // real one, leading space and all.
  it('reads a folder path whether or not its separator is padded', () => {
    const csv = [
      'url,folder',
      'https://example.com/a,Archive / Job Search',
      'https://example.com/b,Archive/Job Search',
    ].join('\n');

    const [padded, tight] = parseRaindropCsv(csv);
    expect(padded.folderPath).toEqual(['Archive', 'Job Search']);
    expect(tight.folderPath).toEqual(padded.folderPath);
  });

  // Raindrop's EXPORT writes each collection name as-is and joins the chain with
  // ` / ` (a real one: __fixtures__/raindrop). So in a file with its header, a
  // bare slash is part of a name — splitting on it would invent two lists.
  it('splits a Raindrop export only on its padded separator', () => {
    const csv = [
      'id,title,note,excerpt,url,folder',
      '1,A,,,https://example.com/a,Marketing / AEO/GEO',
    ].join('\n');

    expect(parseRaindropCsv(csv)[0].folderPath).toEqual(['Marketing', 'AEO/GEO']);
  });

  // Unsorted is Raindrop's inbox, not a collection the user made: it crosses as
  // the default list. Only at the top, and only in Raindrop's file — in any
  // other CSV, a folder named Unsorted is the user's.
  it("lands Raindrop's Unsorted in the default list", () => {
    const raindrop = [
      'id,title,note,excerpt,url,folder',
      '1,A,,,https://example.com/a,Unsorted',
      '2,B,,,https://example.com/b,Work / Unsorted',
    ].join('\n');
    expect(parseRaindropCsv(raindrop).map((link) => link.folderPath)).toEqual([
      [],
      ['Work', 'Unsorted'],
    ]);

    const other = 'url,folder\nhttps://example.com/a,Unsorted\n';
    expect(parseRaindropCsv(other)[0].folderPath).toEqual(['Unsorted']);
  });

  // One note per link here, so Raindrop's highlights fold into it as quotes,
  // after the note the user typed — netscape.ts folds the HTML's the same way.
  it('folds the highlights column into the note, after the typed note', () => {
    const csv = [
      'url,note,highlights',
      'https://example.com/a,"my note","Highlight:first\n\nHighlight:second, over\ntwo lines"',
      'https://example.com/b,,Highlight:only',
    ].join('\n');

    expect(parseRaindropCsv(csv).map((link) => link.note)).toEqual([
      'my note\n\n> first\n\n> second, over\n> two lines',
      '> only',
    ]);
  });

  it('tags a Raindrop favorite, once', () => {
    const csv = [
      'url,tags,favorite',
      'https://example.com/a,,true',
      'https://example.com/b,"Favorites, x",true',
      'https://example.com/c,,false',
    ].join('\n');

    expect(parseRaindropCsv(csv).map((link) => link.tagNames)).toEqual([
      ['Favorites'],
      ['Favorites', 'x'],
      [],
    ]);
  });

  it('handles quoted fields with embedded newlines, commas, and doubled quotes', () => {
    const csv = 'url,note\nhttps://example.com/a,"a ""b"",\nc"\n';
    expect(parseRaindropCsv(csv)).toEqual([
      { url: 'https://example.com/a', note: 'a "b",\nc', tagNames: [], folderPath: [] },
    ]);
  });

  it('skips rows whose url cannot be a stored link and blank lines', () => {
    const csv = ['url,title', 'not a url,Nope', '', 'https://example.com/ok,OK', ''].join('\n');
    expect(parseRaindropCsv(csv).map((l) => l.url)).toEqual(['https://example.com/ok']);
  });

  it('returns [] without a url column or without data rows', () => {
    expect(parseRaindropCsv('title,folder\nA,B\n')).toEqual([]);
    expect(parseRaindropCsv('url,title\n')).toEqual([]);
    expect(parseRaindropCsv('')).toEqual([]);
  });

  it('strips a UTF-8 BOM before the header', () => {
    const csv = '﻿url,title\nhttps://example.com/a,A\n';
    expect(parseRaindropCsv(csv)).toEqual([
      { url: 'https://example.com/a', customTitle: 'A', tagNames: [], folderPath: [] },
    ]);
  });
});

// The scanner builds a field from slices of runs, not a character at a time
// (csv.ts, scanCsvSteps), so every place a run meets something else is a place
// a character can be dropped or doubled: a quote opening or closing mid-field, a
// doubled quote between two runs, the last field with no line break after it.
describe('scanCsv', () => {
  it.each([
    [
      'CRLF, LF and a lone CR between rows',
      'a,b\r\nc,d\ne\rf',
      [['a', 'b'], ['c', 'd'], ['e'], ['f']],
      false,
    ],
    ['an unquoted last field with no line break', 'a,bc', [['a', 'bc']], false],
    ['doubled quotes between runs', '"x""y""z",w\n', [['x"y"z', 'w']], false],
    ['a comma and a line break inside quotes', '"a,\nb",c\n', [['a,\nb', 'c']], false],
    ['empty fields', ',,\n', [['', '', '']], false],
    ['text after a closing quote', '"ab"cd,e\n', [['abcd', 'e']], true],
    ['a quote opening mid-field', 'ab"cd",e\n', [['abcd', 'e']], true],
    ['a quote never closed', '"ab,c\nd', [['ab,c\nd']], true],
  ])('reads %s', (_, text, rows, malformed) => {
    expect(scanCsv(text)).toEqual({ rows, malformed });
  });
});
