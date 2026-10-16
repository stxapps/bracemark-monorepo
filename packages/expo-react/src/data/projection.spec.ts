// Specs for the expo projector. web-react's projection.spec.ts is the canonical statement
// of what these columns MEAN; this is a drift guard, because the two projectors are
// duplicated SOURCE — a spec that passes on web's copy proves nothing about this one. Edit
// this file's link branch and nothing in the workspace fails (docs/testing.md, _the ported
// pair_).
//
// The property worth duplicating in full is the EXCLUSIVITY: `itemListId`/`itemTagIds` are
// projected for links and nothing else, and `itemFacetStatuses` for extractions and
// nothing else. On this platform those two arrays are not index columns but JUNCTION-TABLE
// rows (db.ts's transposed invariant), written in the same transaction as the `items` row
// — so a stray projection here doesn't just widen an index, it puts rows of the wrong type
// into `item_tag_ids` / `item_facet_statuses`, which the link queries JOIN against
// unconditionally.
//
// The one genuine divergence from web is asserted separately: there is no `data`-for-
// content here — `files/` plaintext lives on disk, and its materialization flag
// (`hasDataFile`) is the engine's, never the projector's.
//
// A pure function: no sqlite, no native seam, nothing to mock.

import {
  canonicalUrlKey,
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  type Link,
  LINKS_PREFIX,
  linkSchema,
  LISTS_PREFIX,
  MY_LIST_ID,
  newFacet,
  pathFromId,
  PINS_PREFIX,
  SETTINGS_GENERAL_PATH,
  SETTINGS_PREFIX,
  TAGS_PREFIX,
  utf8,
} from '@stxapps/shared';

import { type ItemRecord, itemTypeForPath, parseBlob, toItemRecord } from './projection';

const bytes = (value: unknown): Uint8Array => utf8(JSON.stringify(value));

const link = (patch: Partial<Link> = {}): Link => ({
  url: 'https://example.com/a',
  listId: MY_LIST_ID,
  tagIds: ['t_1', 't_2'],
  createdAt: 100,
  updatedAt: 200,
  ...patch,
});

// A blob under every namespace, so the exclusivity checks cover the whole ItemType union
// rather than the two branches that project columns today.
const ONE_OF_EACH: { path: string; data: Uint8Array }[] = [
  { path: pathFromId('l_1', LINKS_PREFIX), data: bytes(link()) },
  {
    path: pathFromId('li_1', LISTS_PREFIX),
    data: bytes({
      id: 'li_1',
      name: 'Reading',
      parentId: null,
      rank: 'a0',
      createdAt: 1,
      updatedAt: 2,
    }),
  },
  {
    path: pathFromId('t_1', TAGS_PREFIX),
    data: bytes({
      id: 't_1',
      name: 'rust',
      parentId: null,
      rank: 'a0',
      createdAt: 1,
      updatedAt: 2,
    }),
  },
  {
    path: pathFromId('l_1', PINS_PREFIX),
    data: bytes({ id: 'l_1', rank: 'a0', createdAt: 1, updatedAt: 2 }),
  },
  {
    path: pathFromId('l_1', EXTRACTIONS_PREFIX),
    data: bytes({ id: 'l_1', facets: {}, createdAt: 1, updatedAt: 2 }),
  },
  { path: SETTINGS_GENERAL_PATH, data: bytes({ createdAt: 1, updatedAt: 2 }) },
  { path: pathFromId('f_1', FILES_PREFIX), data: utf8('raw file bytes') },
];

describe('itemTypeForPath', () => {
  it.each([
    [LINKS_PREFIX, 'link'],
    [LISTS_PREFIX, 'list'],
    [TAGS_PREFIX, 'tag'],
    [PINS_PREFIX, 'pin'],
    [EXTRACTIONS_PREFIX, 'extraction'],
    [SETTINGS_PREFIX, 'setting'],
    [FILES_PREFIX, 'file'],
  ])('maps %s to %s', (prefix, expected) => {
    expect(itemTypeForPath(`${prefix}x.enc`)).toBe(expected);
  });

  it('leaves an unknown namespace untyped rather than guessing', () => {
    expect(itemTypeForPath('summaries/s_1.enc')).toBeUndefined();
  });
});

describe('parseBlob', () => {
  it('returns undefined for a record with no bytes', () => {
    expect(parseBlob(undefined, linkSchema)).toBeUndefined();
  });

  it('returns undefined for bytes that are not JSON', () => {
    expect(parseBlob(utf8('<not json>'), linkSchema)).toBeUndefined();
  });

  it('returns undefined for JSON that fails the schema', () => {
    expect(parseBlob(bytes({ url: 'https://example.com' }), linkSchema)).toBeUndefined();
  });

  // The `looseObject` half: an unknown field survives, which is what lets a record written
  // by a newer client round-trip back to it instead of being stripped on re-encrypt.
  it('keeps unknown fields so a decoded entity still round-trips', () => {
    const parsed = parseBlob(bytes({ ...link(), futureField: 'keep me' }), linkSchema);
    expect(parsed).toMatchObject({ futureField: 'keep me' });
  });
});

describe('toItemRecord', () => {
  it('projects a link into the columns its queries are built on', () => {
    const path = pathFromId('l_1', LINKS_PREFIX);

    expect(toItemRecord(path, 500, bytes(link()))).toMatchObject({
      path,
      updatedAt: 500,
      itemType: 'link',
      itemCreatedAt: 100,
      itemUpdatedAt: 200,
      itemListId: MY_LIST_ID,
      itemTagIds: ['t_1', 't_2'],
      itemUrl: 'https://example.com/a',
    });
  });

  // The column is a set on both platforms (projection.ts): expo stores each id as a
  // junction row whose primary key a repeat would hit, failing the pull's write.
  it('projects a tag the link names twice once, in first-seen order', () => {
    const record = toItemRecord(
      pathFromId('l_1', LINKS_PREFIX),
      1,
      bytes(link({ tagIds: ['t_2', 't_1', 't_2'] })),
    );

    expect(record.itemTagIds).toEqual(['t_2', 't_1']);
  });

  it('derives itemUrlKey with canonicalUrlKey rather than storing the raw url', () => {
    const url = 'HTTPS://WWW.Example.com:443/a/?b=2&a=1#frag';
    const record = toItemRecord(pathFromId('l_1', LINKS_PREFIX), 1, bytes(link({ url })));

    expect(record.itemUrl).toBe(url);
    expect(record.itemUrlKey).toBe(canonicalUrlKey(url));
  });

  it('projects no itemUrlKey when the url has no canonical identity', () => {
    const record = toItemRecord(
      pathFromId('l_1', LINKS_PREFIX),
      1,
      bytes(link({ url: 'just some words' })),
    );

    expect(record.itemUrlKey).toBeUndefined();
  });

  // THE DRIFT GUARD THAT MATTERS. Here these are junction rows, not index entries, so a
  // stray projection writes rows of the wrong type into `item_tag_ids` — which every link
  // query joins against without a type filter.
  it('projects itemListId / itemTagIds for links and for NOTHING else', () => {
    const projected = ONE_OF_EACH.map(({ path, data }) => toItemRecord(path, 1, data));

    const carriers = projected.filter(
      (record) => record.itemListId !== undefined || record.itemTagIds !== undefined,
    );
    expect(carriers.map((record) => record.itemType)).toEqual(['link']);
  });

  it('projects itemFacetStatuses for extractions and for NOTHING else', () => {
    const projected = ONE_OF_EACH.map(({ path, data }) =>
      path.startsWith(EXTRACTIONS_PREFIX)
        ? toItemRecord(
            path,
            1,
            bytes({
              id: 'l_1',
              facets: { titleImage: newFacet('done', 'expo:fg') },
              createdAt: 1,
              updatedAt: 2,
            }),
          )
        : toItemRecord(path, 1, data),
    );

    const carriers = projected.filter((record) => record.itemFacetStatuses !== undefined);
    expect(carriers.map((record) => record.itemType)).toEqual(['extraction']);
  });

  it('projects one status-colon-facet token per recorded facet', () => {
    const record = toItemRecord(
      pathFromId('l_1', EXTRACTIONS_PREFIX),
      1,
      bytes({
        id: 'l_1',
        facets: {
          titleImage: newFacet('done', 'expo:fg'),
          screenshot: newFacet('failed', 'expo:fg'),
        },
        createdAt: 1,
        updatedAt: 2,
      }),
    );

    expect(record.itemFacetStatuses?.sort()).toEqual(['done:titleImage', 'failed:screenshot']);
  });

  // PENDING IS ABSENCE: no token, so the pending tally stays a set difference. A synthesized
  // `pending:` row here would land in the facet junction and make the exact counts wrong in
  // the one direction the extract-all wake can't tolerate.
  it('projects an empty token list for an extraction with no settled facets', () => {
    const record = toItemRecord(
      pathFromId('l_1', EXTRACTIONS_PREFIX),
      1,
      bytes({ id: 'l_1', facets: {}, createdAt: 1, updatedAt: 2 }),
    );

    expect(record.itemFacetStatuses).toEqual([]);
  });

  // THE PLATFORM DIVERGENCE. `files/` plaintext lives on disk here, and `hasDataFile` is
  // the engine's lazy-load bookkeeping — a projector that set it would claim a file is
  // materialized when nothing has written one, and the render path would point expo-image
  // at a uri with nothing behind it.
  it('projects nothing for files/ content, and never claims it is materialized', () => {
    const data = utf8('raw file bytes');
    const path = pathFromId('f_1', FILES_PREFIX);

    expect(toItemRecord(path, 7, data)).toEqual<ItemRecord>({
      path,
      updatedAt: 7,
      data,
      itemType: 'file',
    });
    expect(toItemRecord(path, 7)).toEqual<ItemRecord>({
      path,
      updatedAt: 7,
      data: undefined,
      itemType: 'file',
    });
  });

  it('stores the bytes of an unparseable record but projects no columns from it', () => {
    const data = bytes({ nothing: 'like a link' });
    const record = toItemRecord(pathFromId('l_1', LINKS_PREFIX), 9, data);

    expect(record.data).toBe(data);
    expect(record.itemType).toBe('link');
    expect(record.itemListId).toBeUndefined();
  });

  it('stores an unknown namespace as untyped bytes', () => {
    const data = bytes({ createdAt: 1, updatedAt: 2 });

    expect(toItemRecord('summaries/s_1.enc', 3, data)).toEqual<ItemRecord>({
      path: 'summaries/s_1.enc',
      updatedAt: 3,
      data,
      itemType: undefined,
    });
  });

  // The R2 clock (what the engine reconciles on) and the entity's own edit time (what a
  // view orders by) are different numbers a projection could easily conflate.
  it('keeps the R2 updatedAt and the entity updatedAt apart', () => {
    const record = toItemRecord(
      pathFromId('li_1', LISTS_PREFIX),
      999,
      bytes({
        id: 'li_1',
        name: 'Reading',
        parentId: null,
        rank: 'a0',
        createdAt: 10,
        updatedAt: 20,
      }),
    );

    expect([record.updatedAt, record.itemUpdatedAt, record.itemCreatedAt]).toEqual([999, 20, 10]);
  });

  // The concern-agnostic decode: a settings concern this build has never heard of still
  // projects its ordering columns, with no branch added here.
  it('projects a settings concern it has no schema for', () => {
    const record = toItemRecord('settings/future.enc', 1, bytes({ createdAt: 5, updatedAt: 6 }));

    expect(record.itemType).toBe('setting');
    expect(record.itemUpdatedAt).toBe(6);
  });
});
