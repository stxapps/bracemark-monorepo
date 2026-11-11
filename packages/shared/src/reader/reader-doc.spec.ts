import { type ReaderDoc, readerDocSchema, readerDocText, readerPublishedAt } from './reader-doc';

const doc = (blocks: ReaderDoc['blocks'], extra: Partial<ReaderDoc> = {}): ReaderDoc => ({
  version: 1,
  capturedAt: Date.UTC(2026, 10, 9),
  blocks,
  ...extra,
});

const TABLE: ReaderDoc['blocks'][number] = {
  id: 'b1',
  kind: 'table',
  runs: [{ text: 'Prices' }],
  rows: [
    {
      cells: [
        { runs: [{ text: 'Plan' }], header: true },
        { runs: [{ text: 'Price' }], header: true },
      ],
    },
    { cells: [{ runs: [{ text: 'Plus' }] }, { runs: [{ text: 'first\nsecond' }] }] },
  ],
};

describe('readerDocSchema', () => {
  // The format's promise to older and newer clients alike: a kind or a field this
  // version doesn't know survives a parse, so a copy round-trips instead of emptying.
  it('round-trips a table, and a block kind and fields it does not know', () => {
    const stored = doc([
      { id: 'b0', kind: 'paragraph', runs: [{ text: 'Before.' }] },
      { ...TABLE, future: { any: 'thing' } },
      { id: 'b2', kind: 'poll', options: ['a', 'b'] },
    ]);

    expect(readerDocSchema.parse(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
  });
});

describe('readerDocText', () => {
  it('reads a table as its caption, then a line per row with a tab between cells', () => {
    expect(
      readerDocText(doc([{ id: 'b0', kind: 'paragraph', runs: [{ text: 'Before.' }] }, TABLE])),
    ).toBe('Before.\nPrices\nPlan\tPrice\nPlus\tfirst second');
  });
});

describe('readerPublishedAt', () => {
  const at = (publishedTime: string | undefined) =>
    readerPublishedAt({ publishedTime, capturedAt: Date.UTC(2026, 10, 9) });

  it('reads the date a page gave', () => {
    expect(at('2026-11-03T10:00:00Z')).toBe(Date.UTC(2026, 10, 3, 10));
  });

  it('answers nothing for no date, an unreadable one, or one after the copy was taken', () => {
    expect(at(undefined)).toBeUndefined();
    expect(at('')).toBeUndefined();
    expect(at('last Tuesday')).toBeUndefined();
    expect(at('2031-01-01T00:00:00Z')).toBeUndefined();
  });
});
