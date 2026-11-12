import {
  READER_STORE_MAX_BLOCKS,
  READER_STORE_MAX_CHARS,
  READER_TABLE_MAX_COLUMNS,
  READER_TABLE_MAX_ROWS,
  type ReaderDoc,
  readerDocSchema,
  readerDocText,
  readerDocWithinCaps,
  readerPublishedAt,
} from './reader-doc';

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

// The STORE EDGE's size ceilings. The schema has no `.max()` (a cap there silently empties an old
// copy), and the walker's caps bind only where the walker is trusted; on the WebView and Safari
// doors it runs in the page. So a copy the store accepts, and a blob the reader opens, is held to
// these, and each is a way a few KB could cost a reader a gigabyte.
describe('readerDocWithinCaps', () => {
  const para = (text: string, id = 'b0') => ({ id, kind: 'paragraph', runs: [{ text }] });

  it('accepts an ordinary article and a table at the ceilings', () => {
    expect(readerDocWithinCaps(doc([para('Hello.'), TABLE]))).toBe(true);
    const grid = {
      id: 'b0',
      kind: 'table',
      rows: Array.from({ length: READER_TABLE_MAX_ROWS }, () => ({
        cells: Array.from({ length: READER_TABLE_MAX_COLUMNS }, () => ({ runs: [{ text: 'x' }] })),
      })),
    };
    expect(readerDocWithinCaps(doc([grid]))).toBe(true);
  });

  it('refuses more blocks than the walker ever writes', () => {
    const blocks = Array.from({ length: READER_STORE_MAX_BLOCKS + 1 }, (_, i) =>
      para('x', `b${i}`),
    );
    expect(readerDocWithinCaps(doc(blocks))).toBe(false);
    expect(readerDocWithinCaps(doc(blocks.slice(1)))).toBe(true);
  });

  it('counts every string a reader would draw: runs, text, cells, the title', () => {
    const big = 'x'.repeat(READER_STORE_MAX_CHARS);
    expect(readerDocWithinCaps(doc([para(big)]))).toBe(true);
    expect(readerDocWithinCaps(doc([para(big), para('y')]))).toBe(false);
    expect(readerDocWithinCaps(doc([{ id: 'b0', kind: 'code', text: big + 'y' }]))).toBe(false);
    expect(readerDocWithinCaps(doc([para(big)], { title: 'y' }))).toBe(false);
    const cell = { id: 'b0', kind: 'table', rows: [{ cells: [{ runs: [{ text: big + 'y' }] }] }] };
    expect(readerDocWithinCaps(doc([cell]))).toBe(false);
  });

  it('refuses a table longer or wider than the walker keeps', () => {
    const rows = Array.from({ length: READER_TABLE_MAX_ROWS + 1 }, () => ({ cells: [] }));
    expect(readerDocWithinCaps(doc([{ id: 'b0', kind: 'table', rows }]))).toBe(false);
    const wide = {
      cells: Array.from({ length: READER_TABLE_MAX_COLUMNS + 1 }, () => ({
        runs: [{ text: 'x' }],
      })),
    };
    expect(readerDocWithinCaps(doc([{ id: 'b0', kind: 'table', rows: [wide] }]))).toBe(false);
  });
});
