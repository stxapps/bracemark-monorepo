import { parseImportText } from './parse';

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
