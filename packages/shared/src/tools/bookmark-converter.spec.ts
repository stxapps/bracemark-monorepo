import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { scanCsv } from '../import/csv';
import { parseNetscapeHtml } from '../import/netscape';
import { parseImportText } from '../import/parse';
import {
  BOOKMARK_CONVERTER_MAX_ROWS,
  BOOKMARK_OUTPUTS,
  bookmarkReceiptText,
  convertBookmarkFiles,
} from './bookmark-converter';

const ROOT = join(__dirname, '..', 'import', '__fixtures__');
const fixture = (name: string) => ({ name, text: readFileSync(join(ROOT, name), 'utf8') });
const fixtures = [
  'raindrop/raindrop.csv',
  'raindrop/raindrop.html',
  'linkwarden-export.json',
  'brace-export.json',
  ...readdirSync(join(ROOT, 'netscape'))
    .filter((name) => /\.htm/.test(name))
    .map((name) => `netscape/${name}`),
];

for (const name of fixtures) {
  for (const output of BOOKMARK_OUTPUTS) {
    it(`converts ${name} to ${output.id} with accounted records and unchanged web addresses`, () => {
      const source = fixture(name);
      const original = parseImportText(source.text, name)
        .links.map((link) => link.url)
        .sort();
      const converted = convertBookmarkFiles([source], output.id);
      expect(converted.receipt.webLinks).toBe(original.length);
      expect(converted.receipt.sourceRows).toBe(original.length + converted.receipt.skippedRows);
      const actual =
        output.id === 'text'
          ? converted.content.trim().split('\n')
          : parseImportText(converted.content, `out.${output.extension}`).links.map(
              (link) => link.url,
            );
      expect(actual.sort()).toEqual(original);
      expect(bookmarkReceiptText(converted)).toContain(converted.receipt.sourceFormat);
    });
  }
}

it('accounts for invalid rows, unknown columns, repeated addresses, and normalization', () => {
  const result = convertBookmarkFiles([
    {
      name: 'links.csv',
      text: 'url,title,folder,cover\nexample.com/a,First,Work,img.png\nhttp://example.com/a,Again,Other,\njavascript:alert(1),Script,Work,\n,Missing,,',
    },
  ]);
  expect(result.receipt).toMatchObject({
    sourceRows: 4,
    webLinks: 2,
    skippedRows: 2,
    possibleDuplicates: 1,
    uniqueUrls: 1,
  });
  expect(result.receipt.excludedRows).toEqual([
    { file: 'links.csv', row: 4, reason: 'Not a web address' },
    { file: 'links.csv', row: 5, reason: 'No address' },
  ]);
  expect(result.receipt.losses.join(' ')).toContain('cover');
  expect(result.receipt.warnings.join(' ')).toContain('https:// prefix');
});

it('preserves root bookmarks, exact punctuation in URLs, and absent dates in every output', () => {
  for (const { id } of BOOKMARK_OUTPUTS) {
    const result = convertBookmarkFiles(
      [
        {
          name: 'urls.txt',
          text: 'https://example.com/why?\nhttps://example.com/hello!\nhttps://example.com/page.',
        },
      ],
      id,
    );
    expect(result.receipt.webLinks).toBe(3);
    expect(result.content).toContain('https://example.com/why?');
    expect(result.content).not.toContain('1970');
    if (id === 'csv') expect(scanCsv(result.content).rows[1][5]).toBe('');
  }
});

it('preserves identified empty folders in HTML and reports removal in CSV and text', () => {
  const source = {
    name: 'browser.html',
    text: '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3>Empty</H3><DL></DL><DT><A HREF="https://example.com">Home</A></DL>',
  };
  expect(convertBookmarkFiles([source]).content).toContain('<H3>Empty</H3>');
  for (const output of ['csv', 'text'] as const) {
    const result = convertBookmarkFiles([source], output);
    expect(result.receipt.emptyFolders).toBe(1);
    expect(result.receipt.losses).toContain('1 empty folders are not included.');
  }
});

it('protects spreadsheet cells and reports the changes, including folder and tag ambiguity', () => {
  const source = {
    name: 'backup.json',
    text: JSON.stringify({
      collections: [
        {
          id: 1,
          name: '=Work/Study',
          links: [
            {
              url: 'https://example.com',
              name: '=1+1',
              description: '+cmd',
              tags: [{ name: '@tag,other' }],
            },
          ],
        },
      ],
    }),
  };
  const result = convertBookmarkFiles([source], 'csv');
  const row = scanCsv(result.content).rows[1];
  expect(row.slice(1, 5)).toEqual(["'=Work/Study", "'=1+1", "'+cmd", "'@tag,other"]);
  expect(result.receipt.losses.join(' ')).toMatch(/titles.*folder paths.*notes.*tag sets/);
  expect(result.receipt.warnings.join(' ')).toContain('apostrophe');
});

it('reports all metadata removed by URL text and keeps the same-URL copies', () => {
  const source = {
    name: 'links.csv',
    text: 'url,title,note,folder,tags,created\nhttps://example.com,A,Note,Work,Tag,2024-01-01\nhttps://example.com,B,,Personal,,',
  };
  const result = convertBookmarkFiles([source], 'text');
  expect(result.content).toBe('https://example.com\nhttps://example.com\n');
  expect(result.receipt.losses.join(' ')).toMatch(
    /titles.*folder paths.*notes.*tag sets.*saved dates/,
  );
});

it('keeps Pocket archive links with an explicit ordinary-folder warning', () => {
  const result = convertBookmarkFiles([
    {
      name: 'part_0.csv',
      text: 'title,url,time_added,tags,status\nSaved,https://example.com,1700000000,one|two,archive',
    },
  ]);
  expect(parseNetscapeHtml(result.content)[0]).toMatchObject({
    folderPath: ['Archive'],
    tagNames: ['one', 'two'],
  });
  expect(result.receipt.warnings.join(' ')).toContain('active bookmarks');
});

it('does not turn arbitrary JSON, webpages, or malformed CSV into a plausible list', () => {
  for (const [name, text] of [
    ['wrong.json', '{"url":"https://example.com"}'],
    ['broken.json', '{"collections": ['],
    ['page.html', '<html><a href="https://example.com">A</a></html>'],
    ['bad.csv', 'url,title\nhttps://example.com,"unclosed'],
    ['bad.csv', 'url,url\nhttps://example.com,https://example.org'],
    ['bad.csv', 'url,title\nhttps://example.com,A,extra'],
  ])
    expect(() => convertBookmarkFiles([{ name, text }])).toThrow();
});

it('rejects excess records without offering a partial download', () => {
  expect(() =>
    convertBookmarkFiles([
      { name: 'urls.txt', text: 'https://example.com\n'.repeat(BOOKMARK_CONVERTER_MAX_ROWS + 1) },
    ]),
  ).toThrow('too many rows');
});

it('keeps file provenance and repeats when combining archive parts', () => {
  const result = convertBookmarkFiles([
    { name: 'part_0.csv', text: 'url\nhttps://example.com\nmailto:a@b.com' },
    { name: 'part_1.csv', text: 'url\nhttps://example.com' },
  ]);
  expect(result.receipt).toMatchObject({ sourceRows: 3, webLinks: 2, possibleDuplicates: 1 });
  expect(bookmarkReceiptText(result)).toContain('part_0.csv, record 3');
});

it('refuses truncated HTML instead of hiding a dropped bookmark behind matching output counts', () => {
  for (const body of [
    '<DT><A HREF="https://example.com">Good</A><DT><A HREF="https://lost.example.com">Truncated',
    '<DT><A HREF="https://example.com">Truncated<DT><A HREF="https://lost.example.com">Good</A>',
  ])
    expect(() => convertBookmarkFiles([{ name: 'broken.html', text: `<DL>${body}</DL>` }])).toThrow(
      'incomplete bookmark entry',
    );
});

it('identifies collapsed folder identities before download', () => {
  const text =
    '<DL><DT><H3>Same</H3><DL><DT><A HREF="https://example.com/a">A</A></DL><DT><H3>Same</H3><DL><DT><A HREF="https://example.com/b">B</A></DL></DL>';
  const result = convertBookmarkFiles([{ name: 'duplicates.html', text }]);
  expect(result.receipt.warnings.join(' ')).toContain('Folders with identical paths');
  expect(result.receipt.webLinks).toBe(2);
});
