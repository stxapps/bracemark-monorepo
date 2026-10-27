// Specs for one property of `readLinks`' display rows: a re-read hands back the SAME
// row object for a link whose records didn't change (queries.ts, `viewOf`).
//
// It is a render-cost rule, and nothing else sees it. bracemark-expo's list items are
// React.memo on their props, `link` among them (features/links/main.tsx, itemExtra),
// and the whole loaded prefix is re-read on every page growth, every sync landing and
// every write to any link. With a fresh object per link per read, every mounted item
// re-rendered on each of those — the longest stall of a fast scroll on the list layout
// (docs/e2e.md, _the render leg_). A read that stopped sharing would show the same
// rows, pass every other spec, and put that stall back.
//
// The other half is pinned beside it: a link that DID change must come back as a new
// object, or its item would skip the render that shows the change.

import { emptyQuery, EXTRACTIONS_PREFIX, LINKS_PREFIX, pathFromId, utf8 } from '@stxapps/shared';

import { getDb } from './db';
import { putItemsTx } from './item-store';
import { toItemRecord } from './projection';
import { readLinks } from './queries';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => globalThis.crypto.randomUUID() }));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => globalThis.crypto.randomUUID() }));

function putLink(id: string, stamp: number, url = `https://example.com/${id}`): void {
  const link = { url, listId: 'my-list', tagIds: [], createdAt: 1, updatedAt: stamp };
  getDb().transaction((tx) => {
    putItemsTx(tx, [toItemRecord(pathFromId(id, LINKS_PREFIX), stamp, utf8(JSON.stringify(link)))]);
  });
}

function putExtraction(id: string, stamp: number, title: string): void {
  const extraction = { id, facets: {}, title, createdAt: 1, updatedAt: stamp };
  getDb().transaction((tx) => {
    putItemsTx(tx, [
      toItemRecord(pathFromId(id, EXTRACTIONS_PREFIX), stamp, utf8(JSON.stringify(extraction))),
    ]);
  });
}

const read = async () => {
  const { links } = await readLinks(emptyQuery(), 50);
  return new Map(links.map((link) => [link.path, link]));
};

beforeEach(() => {
  putLink('a', 1);
  putLink('b', 1);
  putLink('c', 1);
});

it('hands back the same row for a link nothing changed', async () => {
  const first = await read();
  const second = await read();

  expect(first.size).toBe(3);
  for (const [path, link] of first) expect(second.get(path)).toBe(link);
});

it('hands back a new row for a link whose own record changed, and only for it', async () => {
  const first = await read();
  putLink('b', 2, 'https://example.com/b-moved');
  const second = await read();

  const b = pathFromId('b', LINKS_PREFIX);
  expect(second.get(b)).not.toBe(first.get(b));
  expect(second.get(b)?.url).toBe('https://example.com/b-moved');
  expect(second.get(pathFromId('a', LINKS_PREFIX))).toBe(first.get(pathFromId('a', LINKS_PREFIX)));
});

// The row joins two records; a title landing in the extraction is a change to the row
// even though the link's own record is untouched.
it('hands back a new row when only its extraction changed', async () => {
  putExtraction('c', 1, 'First title');
  const first = await read();
  putExtraction('c', 2, 'Second title');
  const second = await read();

  const c = pathFromId('c', LINKS_PREFIX);
  // Read through the join at all — an extraction that failed to decode would leave
  // both rows title-less, and equal for the wrong reason.
  expect(first.get(c)?.title).toBe('First title');
  expect(second.get(c)).not.toBe(first.get(c));
  expect(second.get(c)?.title).toBe('Second title');
});
