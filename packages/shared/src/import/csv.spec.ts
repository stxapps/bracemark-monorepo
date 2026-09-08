import { toRaindropCsv } from '../export/csv';
import { parseRaindropCsv } from './csv';

describe('parseRaindropCsv', () => {
  it('parses a real Raindrop-style export: extra columns, any order', () => {
    const csv = [
      'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite',
      '1,Example,"my note",page excerpt,https://example.com/a,Work/Projects,"dev,read later",2023-11-14T22:13:20.000Z,,,false',
      '2,,,,https://example.com/b,,,,,,',
    ].join('\r\n');

    expect(parseRaindropCsv(csv)).toEqual([
      {
        url: 'https://example.com/a',
        title: 'Example',
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
        title: 'Quotes " and, commas',
        note: 'line one\nline two',
        tagNames: ['dev', 'read later'],
        folderPath: ['Parent'],
        createdAt: 1_700_000_000_000,
      },
      {
        url: 'https://example.com/b',
        title: 'B',
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
        title: 'Example',
        tagNames: ['cooking', 'recipes'],
        folderPath: [],
        createdAt: 1_700_000_000_000,
      },
      {
        url: 'https://example.com/b',
        title: 'Old read',
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
        title: 'Shiori',
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

  // Raindrop's own export spells a nested collection with spaces around the
  // separator — `Archive / Job Search` — while its import docs spell the same
  // thing `a/b/c`. Both have to read as the same two-segment path: a segment
  // named ` Job Search` would find no existing list and mint a second one beside
  // the real one, leading space and all.
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
      { url: 'https://example.com/a', title: 'A', tagNames: [], folderPath: [] },
    ]);
  });
});
