import { detectTextImportFormat, isZipBytes } from './detect';

describe('isZipBytes', () => {
  it('recognizes the zip local-file-header magic', () => {
    expect(isZipBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true);
    expect(isZipBytes(new Uint8Array([0x50, 0x4b]))).toBe(false);
    expect(isZipBytes(new TextEncoder().encode('<!DOCTYPE NETSCAPE'))).toBe(false);
  });
});

describe('detectTextImportFormat', () => {
  it('routes a Brace.to export ahead of every text sniff', () => {
    const brace =
      '[\n  {\n    "path": "links/My List/1700000000000-abcd-efgh.json",\n    "data": {}';
    expect(detectTextImportFormat(brace)).toBe('brace');
    // Brace names its export `.txt`; the filename must not pull it back to text.
    expect(detectTextImportFormat(brace, 'Brace.to data 2026-08-10.txt')).toBe('brace');
    // A stored page title carrying markup must not win the anchor test below.
    expect(
      detectTextImportFormat('[{"path":"links/My List/1-a-b.json","data":{"url":"</a>"}}]'),
    ).toBe('brace');
    // A JSON array that isn't one still falls through.
    expect(detectTextImportFormat('[{"url":"https://example.com"}]')).toBe('text');
  });

  it('routes on the Netscape doctype or any closing anchor', () => {
    expect(detectTextImportFormat('<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>')).toBe('netscape');
    expect(detectTextImportFormat('<DT><A HREF="https://x.com">x</A>')).toBe('netscape');
  });

  it('routes a url-columned header (or .csv name) to csv', () => {
    expect(detectTextImportFormat('id,title,url,folder\n1,A,https://x.com,')).toBe('csv');
    expect(detectTextImportFormat('URL,Folder\nhttps://x.com,Work')).toBe('csv');
    expect(detectTextImportFormat('anything at all', 'links.csv')).toBe('csv');
  });

  it('falls back to plain text', () => {
    expect(detectTextImportFormat('https://example.com/a\nhttps://example.com/b\n')).toBe('text');
    expect(detectTextImportFormat('just some prose')).toBe('text');
    expect(detectTextImportFormat('a,b\n1,2', 'data.txt')).toBe('text');
  });

  it('lets the filename break ties for renamed bookmark files', () => {
    expect(detectTextImportFormat('no tags here', 'bookmarks.html')).toBe('netscape');
  });
});
