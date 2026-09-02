import { parseImportText } from '../import/parse';
import type { ExportBundle } from './bundle';
import { toUrlText } from './text';

function bundle(folders: ExportBundle['folders']): ExportBundle {
  return { folders, exportedAt: 0 };
}

function link(url: string) {
  return { url, title: url, tagNames: [], createdAt: 0, updatedAt: 0 };
}

describe('toUrlText', () => {
  it('returns empty output for an empty bundle', () => {
    expect(toUrlText(bundle([]))).toBe('');
    expect(toUrlText(bundle([{ name: 'Empty', links: [], children: [] }]))).toBe('');
  });

  it('writes one url per line in walk order with a trailing newline', () => {
    const text = toUrlText(
      bundle([
        {
          name: 'A',
          links: [link('https://a.example/1'), link('https://a.example/2')],
          children: [{ name: 'B', links: [link('https://b.example/1')], children: [] }],
        },
      ]),
    );
    expect(text).toBe('https://a.example/1\nhttps://a.example/2\nhttps://b.example/1\n');
  });

  it('walks every top-level folder in order, links before children at each level', () => {
    // The one order test used a single top-level folder, so the loop over
    // `bundle.folders` and the links-then-children order at depth were both
    // unexercised. This is the walk contract bundle.ts states and all three
    // serializers re-implement.
    const text = toUrlText(
      bundle([
        {
          name: 'A',
          links: [link('https://a.example/1')],
          children: [
            {
              name: 'A1',
              links: [link('https://a1.example/1')],
              children: [{ name: 'A1a', links: [link('https://a1a.example/1')], children: [] }],
            },
            { name: 'A2', links: [link('https://a2.example/1')], children: [] },
          ],
        },
        { name: 'B', links: [link('https://b.example/1')], children: [] },
      ]),
    );

    expect(text.trimEnd().split('\n')).toEqual([
      'https://a.example/1',
      'https://a1.example/1',
      'https://a1a.example/1',
      'https://a2.example/1',
      'https://b.example/1',
    ]);
  });

  it('emits no trailing blank line for an empty bundle', () => {
    // '' rather than '\n' — a lone newline would import as zero links anyway,
    // but it also makes the file non-empty on disk, which reads as "something
    // was exported" to a user checking the download.
    expect(toUrlText(bundle([]))).toBe('');
  });
});

// export/text.ts and import/text.ts are documented as read mirrors, and nothing
// tested the pair. Going through parseImportText pins detection too: a URL list
// must not sniff as one of the richer formats.
describe('toUrlText → parseImportText', () => {
  it('recovers every url, in order, with no folder or tag signal', () => {
    const text = toUrlText(
      bundle([
        {
          name: 'A',
          links: [link('https://a.example/1'), link('https://a.example/2')],
          children: [{ name: 'B', links: [link('https://b.example/1')], children: [] }],
        },
      ]),
    );

    // Plain text carries no structure, so the folders are gone by design — the
    // importer drops every row into its default list.
    expect(parseImportText(text).links).toEqual([
      { url: 'https://a.example/1', tagNames: [], folderPath: [] },
      { url: 'https://a.example/2', tagNames: [], folderPath: [] },
      { url: 'https://b.example/1', tagNames: [], folderPath: [] },
    ]);
  });

  it('round-trips a url with query, fragment and balanced parens intact', () => {
    // The text parser strips trailing prose punctuation and unbalanced closing
    // parens, which is exactly the machinery that could eat a real URL's tail.
    const urls = [
      'https://ex.example/a?b=1&c=2#frag',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://ex.example/path.',
    ];
    const text = toUrlText(bundle([{ name: 'L', links: urls.map(link), children: [] }]));

    expect(parseImportText(text).links.map((row) => row.url)).toEqual([
      'https://ex.example/a?b=1&c=2#frag',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://ex.example/path', // the trailing dot reads as prose, not path
    ]);
  });
});
