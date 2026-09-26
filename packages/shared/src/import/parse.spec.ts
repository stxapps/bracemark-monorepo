import { detectTextImportFormat } from './detect';
import { parseImportText, parseImportTextInChunks } from './parse';
import { PARSE_CHUNK } from './steps';

// The dispatch itself — four lines that were written four times before they lived
// here. What's worth pinning is that each format reaches ITS parser (a misroute
// degrades quietly: the text scanner finds a bookmarks file's URLs and drops every
// folder, tag and date it had), that the filename still only breaks ties, and that
// the bundle a caller gets back is its own.

const BRACE = JSON.stringify([
  {
    path: 'links/My List/1700000000000-abcd-efgh.json',
    data: {
      id: '1700000000000-abcd-efgh',
      url: 'https://example.com/a',
      addedDT: 1_700_000_000_000,
      custom: { image: 'cdroot/images/kept.png' },
    },
  },
  { path: 'images/kept.png', data: 'data:image/png;base64,aGk=' },
]);

const NETSCAPE = [
  '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
  '<DL><p>',
  '    <DT><H3>Work</H3>',
  '    <DL><p>',
  '        <DT><A HREF="https://example.com/a" ADD_DATE="1700000000" TAGS="dev">A</A>',
  '    </DL><p>',
  '</DL><p>',
].join('\n');

const CSV = 'url,folder,title\nhttps://example.com/a,Work,A\n';

describe('parseImportText', () => {
  it('routes a Brace export to its parser, blobs included', () => {
    // The reason the dispatch returns a BUNDLE: this is the only format that
    // carries bytes, and a rows-only return would make every caller special-case it.
    const bundle = parseImportText(BRACE);

    expect(bundle.links).toHaveLength(1);
    expect(bundle.links[0].imageRef).toBe('images/kept.png');
    expect([...bundle.images.keys()]).toEqual(['images/kept.png']);
  });

  it('routes bookmarks HTML to the netscape parser, structure intact', () => {
    // Asserting a field only THAT parser produces: the text fallback would find the
    // same URL and report no folder, no tag and no date — a plausible-looking import
    // that quietly lost everything the file was worth importing for.
    expect(parseImportText(NETSCAPE).links).toEqual([
      {
        url: 'https://example.com/a',
        customTitle: 'A',
        tagNames: ['dev'],
        folderPath: ['Work'],
        createdAt: 1_700_000_000_000,
      },
    ]);
  });

  it('routes a url-columned CSV to the csv parser', () => {
    expect(parseImportText(CSV).links).toEqual([
      { url: 'https://example.com/a', customTitle: 'A', tagNames: [], folderPath: ['Work'] },
    ]);
  });

  it('falls back to the plain-text scanner', () => {
    expect(parseImportText('see https://example.com/a and www.example.com/b').links).toEqual([
      { url: 'https://example.com/a', tagNames: [], folderPath: [] },
      { url: 'https://www.example.com/b', tagNames: [], folderPath: [] },
    ]);
  });

  it('passes the filename through as detection’s tie-break', () => {
    // The parameter exists for a zip entry's name, and it only speaks when the
    // content says nothing — so the same bytes have to land on two different
    // parsers depending on it. A bare URL list is text; under a `.html` name it
    // goes to the tokenizer instead, which finds no anchors in it.
    const bare = 'https://example.com/a';
    expect(parseImportText(bare).links).toHaveLength(1);
    expect(parseImportText(bare, 'bookmarks.html').links).toEqual([]);
    // Same shape for the csv tie-break: no `url` column, so only the name routes it.
    const noUrlHeader = 'title,link\nA,https://example.com/a';
    expect(parseImportText(noUrlHeader).links).toHaveLength(1);
    expect(parseImportText(noUrlHeader, 'links.csv').links).toEqual([]);
    // And content still outranks the name — a Brace export is named `.txt`.
    expect(parseImportText(BRACE, 'Brace.to data.txt').images.size).toBe(1);
  });

  it('gives each interop parse its OWN empty image map', () => {
    // The orchestrators write into what they get back. A hoisted shared empty Map
    // would leak one import's blobs into the next one's bundle, and every test that
    // only reads `.links` would still pass.
    const first = parseImportText('https://example.com/a');
    const second = parseImportText('https://example.com/b');

    expect(first.images).not.toBe(second.images);
    first.images.set('leaked', new Uint8Array([1]));
    expect(second.images.size).toBe(0);
  });
});

// The chunked driver both orchestrators await, so a big file doesn't hold the
// thread for the whole parse — on Hermes that was 0.5–0.8 s at 10,000 links in
// every format (docs/data-lifecycle.md, _readings — expo_). Each parser is one
// generator run by both drivers (steps.ts), and these pin the two ways that
// could still go wrong: a chunked parse that reads the file differently, and a
// parser that never yields — which looks like success everywhere except a
// frozen screen.
describe('parseImportTextInChunks', () => {
  const COUNT = PARSE_CHUNK * 2 + 7;
  const url = (i: number) => `https://example.com/${i}`;
  const indices = Array.from({ length: COUNT }, (_, i) => i);

  // One file per format, each crossing more than one chunk boundary, with the
  // state that spans records in play: folder nesting and <DD> notes in the
  // HTML, a quoted multi-line note in the CSV, collections and a pin in
  // LinkWarden, tags and a revision in Brace.
  const files: [format: string, filename: string, text: string][] = [
    [
      'netscape',
      'bookmarks.html',
      [
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
        '<DL><p>',
        ...indices.flatMap((i) => [
          ...(i % 300 === 0 ? [`<DT><H3>Folder ${i}</H3>`, '<DL><p>'] : []),
          `<DT><A HREF="${url(i)}" ADD_DATE="1700000000" TAGS="t${i % 3}">Link ${i}</A>`,
          ...(i % 4 === 0 ? [`<DD>Note ${i}`] : []),
          ...(i % 300 === 299 ? ['</DL><p>'] : []),
        ]),
        '</DL><p>',
      ].join('\n'),
    ],
    [
      'csv',
      'links.csv',
      [
        'url,folder,title,note,tags',
        ...indices.map((i) => `${url(i)},F${i % 5},Link ${i},"line 1\nline ${i}",t${i % 3}`),
      ].join('\n'),
    ],
    ['text', 'links.txt', indices.map((i) => `see ${url(i)}, then`).join('\n')],
    [
      'linkwarden',
      'backup.json',
      JSON.stringify({
        collections: [0, 1, 2].map((c) => ({
          id: c + 1,
          name: `C${c}`,
          parentId: c === 0 ? null : 1,
          links: indices
            .filter((i) => i % 3 === c)
            .map((i) => ({ id: i + 1, name: `Link ${i}`, url: url(i), tags: [{ name: 't' }] })),
        })),
        pinnedLinks: [{ id: 1 }],
      }),
    ],
    [
      'brace',
      'Brace.to data.txt',
      JSON.stringify([
        ...indices.map((i) => ({
          path: `links/My List/${1700000000000 + i}-abcd-efgh.json`,
          data: { url: url(i), addedDT: 1700000000000 + i },
        })),
        ...indices.map((i) => ({
          path: `tags/t${i % 3}/a/1700000000001/1700000000001/${1700000000000 + i}-abcd-efgh.json`,
          data: {},
        })),
        {
          path: 'links/My List/1700000000000-abcd-efgh-1700000000009.json',
          data: { url: url(-1), addedDT: 1700000000000 },
        },
      ]),
    ],
  ];

  it.each(files)(
    'parses a %s file exactly as the synchronous parse does',
    async (format, filename, text) => {
      // Guards the table itself: a file that detects as some other format would
      // test that format's parser twice and this one never.
      expect(detectTextImportFormat(text, filename)).toBe(format);
      const chunked = await parseImportTextInChunks(text, filename, async () => undefined);
      expect(chunked.links.length).toBeGreaterThan(PARSE_CHUNK * 2);
      expect(chunked).toEqual(parseImportText(text, filename));
    },
  );

  it.each(files)('pauses between chunks of a %s file', async (_format, filename, text) => {
    let pauses = 0;
    await parseImportTextInChunks(text, filename, async () => {
      pauses += 1;
    });
    // At least one pause per PARSE_CHUNK records. Parsers that make more than
    // one pass (the CSV scan, Brace's classify) pause in each, so not exactly.
    expect(pauses).toBeGreaterThanOrEqual(Math.floor(COUNT / PARSE_CHUNK));
  });
});
