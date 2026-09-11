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

  // The precedence itself, in the order the function applies it. Each case is a
  // file that carries TWO formats' signals, and the pair only routes correctly
  // because one of them is positionally anchored.
  describe('precedence between competing signals', () => {
    it('reads our own CSV export as csv even when a title contains an anchor', () => {
      // The regression: a saved page titled `Fixing a stray </a>` used to send the
      // whole export to the Netscape tokenizer, which found no anchors and
      // imported nothing. A title is usually the page's own <title>, so this
      // needs no malice to happen.
      const csv =
        'url,folder,title,note,tags,created\r\n' +
        'https://example.com/a,Work,Fixing a stray </a>,,,2026-01-02T03:04:05.000Z\r\n';

      expect(detectTextImportFormat(csv)).toBe('csv');
      expect(detectTextImportFormat(csv, 'bracemark-export.csv')).toBe('csv');
    });

    it('reads our own CSV export as csv even when a title contains the doctype', () => {
      // The `</a>` case's twin: the doctype test used to match anywhere in the
      // file, so a saved page titled `<!DOCTYPE NETSCAPE-Bookmark-file-1>` routed
      // the export to the HTML tokenizer and imported nothing.
      const csv =
        'url,folder,title,note,tags,created\r\n' +
        'https://example.com/a,Work,"<!DOCTYPE NETSCAPE-Bookmark-file-1>",,,2026-01-02T03:04:05.000Z\r\n';

      expect(detectTextImportFormat(csv)).toBe('csv');
    });

    it('accepts the doctype after a BOM, blank lines or a tab', () => {
      // Anchoring must keep the allowances the brace probe makes: transfers and
      // editors prepend a BOM, and the separator is not always one space.
      for (const head of ['﻿', '\n\n', '  ', '']) {
        expect(detectTextImportFormat(`${head}<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>`)).toBe(
          'netscape',
        );
      }
      expect(detectTextImportFormat('<!doctype\tnetscape-bookmark-file-1>\n<DL><p>')).toBe(
        'netscape',
      );
    });

    it('still claims a bookmarks file whose doctype is not at the head', () => {
      // The safety property that makes anchoring free: any real export with a
      // buried doctype also has anchors, so the scan below catches it. Nothing
      // that used to be netscape stops being netscape.
      expect(
        detectTextImportFormat('<html>\n<!DOCTYPE NETSCAPE>\n<DT><A HREF="https://x.com">x</A>'),
      ).toBe('netscape');
    });

    it('still prefers Netscape when the file opens with the doctype', () => {
      // A bookmarks file whose FIRST link's title looks like a CSV header must not
      // flip to csv — the doctype is the one signal that outranks the header row.
      const html =
        '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n' +
        '<DL><p>\n    <DT><A HREF="https://x.com">url,folder,title</A>\n</DL><p>\n';

      expect(detectTextImportFormat(html)).toBe('netscape');
    });

    it('prefers a url-columned header over an .html filename', () => {
      // Content decides, the filename only breaks ties (this file's header says
      // so) — so a CSV that travelled through chat as .html still reads as csv.
      expect(detectTextImportFormat('url,folder\nhttps://x.com,Work', 'shared.html')).toBe('csv');
    });

    it('keeps the anchor scan for a bookmarks file with no doctype', () => {
      // The scan still earns its place: LinkWarden/Pocket-style fragments and
      // hand-trimmed exports arrive without the doctype, and their first line is
      // not a CSV header, so nothing above claims them.
      expect(detectTextImportFormat('<DT><A HREF="https://x.com">x</A>')).toBe('netscape');
    });
  });
});
