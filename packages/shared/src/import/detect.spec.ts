import { detectTextImportFormat, isZipBytes } from './detect';

describe('isZipBytes', () => {
  it('recognizes the zip local-file-header magic', () => {
    expect(isZipBytes(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true);
    expect(isZipBytes(new Uint8Array([0x50, 0x4b]))).toBe(false);
    expect(isZipBytes(new TextEncoder().encode('<!DOCTYPE NETSCAPE'))).toBe(false);
  });
});

describe('detectTextImportFormat', () => {
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
