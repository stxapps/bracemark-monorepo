import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseNetscapeHtml } from '../import/netscape';
import { convertRaindropCsvToBookmarksHtml } from './bookmark-converter';

const HEADER = 'id,title,note,excerpt,url,folder,tags,created,cover,highlights,favorite';
const FIXTURE = readFileSync(
  join(__dirname, '..', 'import', '__fixtures__', 'raindrop', 'raindrop.csv'),
  'utf8',
);

describe('Raindrop.io CSV to browser bookmarks HTML', () => {
  it('accounts for the real export and keeps every parsed link in the generated file', () => {
    const { html, receipt } = convertRaindropCsvToBookmarksHtml(FIXTURE);
    const converted = parseNetscapeHtml(html);

    expect(receipt.sourceRows).toBe(19);
    expect(receipt.webLinks).toBe(19);
    expect(receipt.skippedRows).toBe(0);
    expect(converted).toHaveLength(19);
    expect(
      converted.some(
        (link) => link.folderPath.join('/') === 'Marketing/SEO/AEO/Search Engines/Google',
      ),
    ).toBe(true);
    expect(receipt.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('exact nesting matters')]),
    );
    expect(receipt.losses).toEqual(
      expect.arrayContaining([expect.stringContaining('cover image')]),
    );
    expect(receipt.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('HTML descriptions')]),
    );
    expect(converted.some((link) => link.note?.includes('Marketing & Technology'))).toBe(true);
  });

  it('reports excluded rows and possible duplicates while leaving copies in the output', () => {
    const csv = [
      HEADER,
      '1,First,,ex,https://example.com/a,Work,one,2024-01-01T00:00:00.000Z,,,false',
      '2,Again,,ex,http://example.com/a,Other,,2024-01-01T00:00:00.000Z,,,false',
      '3,Script,,,javascript:alert(1),Work,,,,,false',
    ].join('\n');
    const { html, receipt } = convertRaindropCsvToBookmarksHtml(csv);

    expect(receipt).toMatchObject({
      sourceRows: 3,
      webLinks: 2,
      skippedRows: 1,
      possibleDuplicates: 1,
    });
    expect(receipt.excludedRows).toEqual([{ row: 4, reason: 'Not a web address' }]);
    expect(parseNetscapeHtml(html).map((link) => link.url)).toEqual([
      'https://example.com/a',
      'http://example.com/a',
    ]);
  });

  it('rejects unrelated and malformed CSV rather than mining URLs from it', () => {
    expect(() => convertRaindropCsvToBookmarksHtml('title,url\nA,https://example.com')).toThrow(
      'Choose a Raindrop.io CSV export',
    );
    expect(() => convertRaindropCsvToBookmarksHtml(`${HEADER}\n1,"Unclosed`)).toThrow(
      'incomplete or misplaced quote',
    );
    expect(() => convertRaindropCsvToBookmarksHtml(`${HEADER}\n1,Two`)).toThrow(
      'different number of columns',
    );
  });

  it('names address normalization before a schemeless URL enters the download', () => {
    const csv = [
      HEADER,
      '1,Example,,,example.com/path,Unsorted,,2024-01-01T00:00:00.000Z,,,false',
    ].join('\n');
    const { html, receipt } = convertRaindropCsvToBookmarksHtml(csv);
    expect(parseNetscapeHtml(html)[0].url).toBe('https://example.com/path');
    expect(receipt.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('given an https:// prefix')]),
    );
  });
});
