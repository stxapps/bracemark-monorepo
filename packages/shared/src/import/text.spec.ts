import { toUrlText } from '../export/text';
import { parseUrlText } from './text';

describe('parseUrlText', () => {
  it('round-trips its own exporter output (one URL per line)', () => {
    const text = toUrlText({
      folders: [
        {
          name: 'L',
          links: [
            {
              url: 'https://example.com/a',
              title: 'A',
              tagNames: [],
              createdAt: 1,
              updatedAt: 1,
            },
            {
              url: 'http://example.com/b?x=1#y',
              title: 'B',
              tagNames: [],
              createdAt: 2,
              updatedAt: 2,
            },
          ],
          children: [],
        },
      ],
      exportedAt: 3,
    });
    expect(parseUrlText(text).map((l) => l.url)).toEqual([
      'https://example.com/a',
      'http://example.com/b?x=1#y',
    ]);
  });

  it('finds URLs inside prose and prepends https:// to www hosts', () => {
    const text = 'see https://example.com/a, then www.example.com/b — done';
    expect(parseUrlText(text).map((l) => l.url)).toEqual([
      'https://example.com/a',
      'https://www.example.com/b',
    ]);
  });

  it('strips trailing punctuation but keeps balanced parens', () => {
    const text = [
      'https://en.wikipedia.org/wiki/Foo_(bar),',
      '(see https://example.com/a).',
      'https://example.com/b...',
    ].join('\n');
    expect(parseUrlText(text).map((l) => l.url)).toEqual([
      'https://en.wikipedia.org/wiki/Foo_(bar)',
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });

  it('ignores prose without URLs and bare words', () => {
    expect(parseUrlText('note to self: buy milk. localhost draft')).toEqual([]);
  });
});
