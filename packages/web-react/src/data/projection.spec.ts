// Specs for the ONE place a decrypted blob becomes an `ItemRecord` — the seam where
// the local store stops being payload-blind (projection.ts). Everything below it moves
// opaque bytes; everything above it reads the `item*` columns projected here. A wrong
// projection is silent in the worst way: the bytes are stored correctly, nothing throws,
// and the record simply stops appearing in a view — or appears in the wrong one.
//
// The sharpest invariant, and the reason this file exists at all, is the EXCLUSIVITY the
// header calls load-bearing: `itemListId` / `itemTagIds` are written for links and for
// nothing else, which is what lets `[itemListId+item*At]` and `*itemTagIds` (db.ts) be
// link-scoped indexes with no `itemType` discriminator in them. If a future branch ever
// fills those columns for another type, `readLinks` (queries.ts) starts returning
// non-link rows and no test, type or lint rule anywhere would say so. So the check below
// is written over EVERY ItemType rather than over the types that exist today.
//
// Pure function, no Dexie: `toItemRecord` never touches the database. The store-level
// consequences of these columns are covered by queries.spec.ts and mutations.spec.ts.

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

import type { ItemRecord } from './db';
import { itemTypeForPath, parseBlob, toItemRecord } from './projection';

const bytes = (value: unknown): Uint8Array => utf8(JSON.stringify(value));

const link = (patch: Partial<Link> = {}): Link => ({
  url: 'https://example.com/a',
  listId: MY_LIST_ID,
  tagIds: ['t_1', 't_2'],
  createdAt: 100,
  updatedAt: 200,
  ...patch,
});

// A blob under every namespace, so the exclusivity check below covers the whole
// ItemType union rather than the two branches that happen to project columns today.
// Each carries the createdAt/updatedAt every synced entity has, so a type that fails
// to project them is a real gap and not a malformed fixture.
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

  // Forward-compat: a namespace this client version doesn't model yet must not be
  // guessed at. `undefined` is what keeps its bytes stored-but-unindexed rather than
  // projected into somebody else's view.
  it('leaves an unknown namespace untyped rather than guessing', () => {
    expect(itemTypeForPath('summaries/s_1.enc')).toBeUndefined();
  });
});

describe('parseBlob', () => {
  // A `files/` record whose content hasn't been lazily downloaded yet (db.ts).
  it('returns undefined for a record with no bytes', () => {
    expect(parseBlob(undefined, linkSchema)).toBeUndefined();
  });

  it('returns undefined for bytes that are not JSON', () => {
    expect(parseBlob(utf8('<not json>'), linkSchema)).toBeUndefined();
  });

  // A forward-incompatible shape from a newer client. The read layer drops it from a
  // view; it must never throw its way up to a render.
  it('returns undefined for JSON that fails the schema', () => {
    expect(parseBlob(bytes({ url: 'https://example.com' }), linkSchema)).toBeUndefined();
  });

  // The `looseObject` half of the contract: an unknown field survives the decode, which
  // is what lets a record round-trip back to the newer client that wrote it instead of
  // being silently stripped on re-encrypt.
  it('keeps unknown fields so a decoded entity still round-trips', () => {
    const parsed = parseBlob(bytes({ ...link(), futureField: 'keep me' }), linkSchema);
    expect(parsed).toMatchObject({ futureField: 'keep me' });
  });
});

describe('toItemRecord', () => {
  it('projects a link into the columns its views are indexed on', () => {
    const path = pathFromId('l_1', LINKS_PREFIX);
    const record = toItemRecord(path, 500, bytes(link()));

    expect(record).toMatchObject({
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

  // `itemUrlKey` is DERIVED here and never read from the blob, so the key rules can
  // evolve without touching synced state (db.ts). Pinned as the relation rather than as
  // a literal, so a refinement to canonicalUrlKey moves this spec with it.
  it('derives itemUrlKey with canonicalUrlKey rather than storing the raw url', () => {
    const url = 'HTTPS://WWW.Example.com:443/a/?b=2&a=1#frag';
    const record = toItemRecord(pathFromId('l_1', LINKS_PREFIX), 1, bytes(link({ url })));

    expect(record.itemUrl).toBe(url);
    expect(record.itemUrlKey).toBe(canonicalUrlKey(url));
    expect(record.itemUrlKey).not.toBe(record.itemUrl);
  });

  // The sparse half of that index: a confirm-saved raw text "link" has no canonical
  // identity, and projecting a bogus key would make two unrelated notes look like
  // duplicates of each other to the dedup lookup.
  it('projects no itemUrlKey when the url has no canonical identity', () => {
    const record = toItemRecord(
      pathFromId('l_1', LINKS_PREFIX),
      1,
      bytes(link({ url: 'just some words' })),
    );

    expect(canonicalUrlKey('just some words')).toBeNull();
    expect(record.itemUrlKey).toBeUndefined();
    expect(record.itemUrl).toBe('just some words');
  });

  // THE LOAD-BEARING ONE (projection.ts, the itemListId note): `[itemListId+item*At]`
  // and `*itemTagIds` are link-scoped indexes for free ONLY because nothing else fills
  // these columns. Written over the whole namespace set, so a new branch that starts
  // projecting them fails here rather than in readLinks' results.
  it('projects itemListId / itemTagIds for links and for NOTHING else', () => {
    const projected = ONE_OF_EACH.map(({ path, data }) => toItemRecord(path, 1, data));

    const carriers = projected.filter(
      (record) => record.itemListId !== undefined || record.itemTagIds !== undefined,
    );
    expect(carriers.map((record) => record.itemType)).toEqual(['link']);
  });

  // The same exclusivity on the other side: `*itemFacetStatuses` counts facet outcomes
  // (readExtractionFacetCounts), so an entry from any other type would land in the
  // Settings tally as a phantom done/failed.
  it('projects itemFacetStatuses for extractions and for NOTHING else', () => {
    const withFacet = ONE_OF_EACH.map(({ path, data }) =>
      path.startsWith(EXTRACTIONS_PREFIX)
        ? toItemRecord(
            path,
            1,
            bytes({
              id: 'l_1',
              facets: { titleImage: newFacet('done', 'server') },
              createdAt: 1,
              updatedAt: 2,
            }),
          )
        : toItemRecord(path, 1, data),
    );

    const carriers = withFacet.filter((record) => record.itemFacetStatuses !== undefined);
    expect(carriers.map((record) => record.itemType)).toEqual(['extraction']);
  });

  it('projects one status-colon-facet token per recorded facet', () => {
    const record = toItemRecord(
      pathFromId('l_1', EXTRACTIONS_PREFIX),
      1,
      bytes({
        id: 'l_1',
        facets: {
          titleImage: newFacet('done', 'server'),
          screenshot: newFacet('failed', 'extension:fg'),
        },
        createdAt: 1,
        updatedAt: 2,
      }),
    );

    expect(record.itemFacetStatuses?.sort()).toEqual(['done:titleImage', 'failed:screenshot']);
  });

  // PENDING IS ABSENCE (entities.ts): there is no `pending` status token, so a facet-less
  // extraction must project an EMPTY token list — not a `pending:` entry, and not
  // `undefined`. The pending count is a set difference over links, and an invented token
  // here would make it wrong in the one direction the extract-all wake can't tolerate.
  it('projects an empty token list for an extraction with no settled facets', () => {
    const record = toItemRecord(
      pathFromId('l_1', EXTRACTIONS_PREFIX),
      1,
      bytes({ id: 'l_1', facets: {}, createdAt: 1, updatedAt: 2 }),
    );

    expect(record.itemFacetStatuses).toEqual([]);
  });

  // A lazily-referenced `files/` record: the row exists (so the engine knows the path)
  // but has no bytes yet. It must still carry its type — that is how a later
  // materialize finds it — and nothing else.
  it('stores a blob-less record with its type and no projected columns', () => {
    const record = toItemRecord(pathFromId('f_1', FILES_PREFIX), 7);

    expect(record).toEqual<ItemRecord>({
      path: pathFromId('f_1', FILES_PREFIX),
      updatedAt: 7,
      data: undefined,
      itemType: 'file',
    });
  });

  // `files/` content is opaque payload — it has no list-view shape at all, so even WITH
  // bytes it projects nothing. (Its bytes are typically not JSON; projecting them would
  // mean decoding every downloaded image on every write.)
  it('projects no columns for files/ content even when its bytes are present', () => {
    const data = utf8('raw file bytes');
    const record = toItemRecord(pathFromId('f_1', FILES_PREFIX), 7, data);

    expect(record).toEqual<ItemRecord>({
      path: pathFromId('f_1', FILES_PREFIX),
      updatedAt: 7,
      data,
      itemType: 'file',
    });
  });

  // Forward-compat, the write half: a typed record this client can't parse keeps its
  // BYTES (so it still syncs and still round-trips to the client that understands it)
  // and is simply absent from the value-based indexes.
  it('stores the bytes of an unparseable record but projects no columns from it', () => {
    const data = bytes({ nothing: 'like a link' });
    const record = toItemRecord(pathFromId('l_1', LINKS_PREFIX), 9, data);

    expect(record.data).toBe(data);
    expect(record.itemType).toBe('link');
    expect(record.itemUpdatedAt).toBeUndefined();
    expect(record.itemListId).toBeUndefined();
  });

  // A namespace this build doesn't model: bytes kept, type undefined, no columns — so
  // it can never surface in a view built for a type it isn't.
  it('stores an unknown namespace as untyped bytes', () => {
    const data = bytes({ createdAt: 1, updatedAt: 2 });
    const record = toItemRecord('summaries/s_1.enc', 3, data);

    expect(record).toEqual<ItemRecord>({
      path: 'summaries/s_1.enc',
      updatedAt: 3,
      data,
      itemType: undefined,
    });
  });

  // The sync `updatedAt` (the R2 clock, what the engine reconciles on) and the entity's
  // own `updatedAt` (the user-visible edit time, what a view orders by) are different
  // numbers that a projection could easily conflate — they only differ when the server
  // stamped a write at a different moment than the client did.
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

    expect(record.updatedAt).toBe(999);
    expect(record.itemUpdatedAt).toBe(20);
    expect(record.itemCreatedAt).toBe(10);
  });

  // The concern-agnostic decode (the `timestampedSchema` note): a settings concern this
  // build has never heard of must still project its ordering columns, with no branch
  // added here — that is the whole point of not decoding against `settingsGeneralSchema`.
  it('projects a settings concern it has no schema for', () => {
    const record = toItemRecord(
      'settings/future.enc',
      1,
      bytes({ createdAt: 5, updatedAt: 6, whatever: true }),
    );

    expect(record.itemType).toBe('setting');
    expect(record.itemCreatedAt).toBe(5);
    expect(record.itemUpdatedAt).toBe(6);
  });
});
