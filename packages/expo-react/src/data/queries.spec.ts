// Specs for the read edge's NAMESPACE reads — the small-collection half of
// queries.ts (lists/tags), where the only non-trivial logic is the system-list
// merge. The link queries are SQL-shaped (indexes, range scans, the clause
// compiler) and belong to an on-device/integration pass, not here.
//
// `mergeSystemLists` is the piece worth pinning: My List / Archive / Trash must
// be present whether or not the account ever stored an override, a stored
// override must WIN over the default (a renamed My List stays renamed), and the
// defaults must carry a synthesized `path` so the UI can target a list that has
// no record yet. The share sheet's picker leans on all three (share-store.ts —
// buildShareLists takes the already-merged set).
//
// And the rule under the merge: a list or tag is read back under its PATH's id,
// never the copy in its plaintext (_the id a list or tag is read under_, below).
//
// Only the row scan is stubbed: `namespaceRows` (item-store.ts) stands in for
// sqlite, everything above it — decode, parseBlob, the merge — runs for real.

import {
  ALL_ID,
  APP_LOCK_ID,
  ARCHIVE_ID,
  buildTree,
  flattenTree,
  type List,
  LISTS_PREFIX,
  MY_LIST_ID,
  pathFromId,
  PINS_PREFIX,
  SYSTEM_LIST_DEFAULTS,
  SYSTEM_LIST_IDS,
  SYSTEM_LIST_NAMES,
  type Tag,
  TAGS_PREFIX,
  TRASH_ID,
  utf8,
} from '@stxapps/shared';

import { readLists, readPins, readTags } from './queries';

// The rows `namespaceRows` hands back, keyed by the prefix asked for.
const mockRowsByPrefix = new Map<string, { path: string; data: Uint8Array }[]>();

// Both modules are real apart from the row scan — db.ts's table objects and
// drizzle column refs are used at queries.ts module scope, so spread the actual
// modules and override only what would reach native sqlite. `getDb` throws
// rather than returning a stub: nothing on the namespace-read path may call it,
// and a loud failure beats a silently empty query.
jest.mock('./item-store', () => ({
  ...jest.requireActual('./item-store'),
  namespaceRows: (prefix: string) => mockRowsByPrefix.get(prefix) ?? [],
}));
jest.mock('./db', () => ({
  ...jest.requireActual('./db'),
  getDb: () => {
    throw new Error('getDb: not stubbed — this spec only exercises namespace reads');
  },
}));
jest.mock('expo-sqlite', () => ({ openDatabaseSync: jest.fn() }));
// queries.ts → file-store → expo-file-system / @stxapps/expo-crypto (native);
// nothing here touches the file path, so inert them.
jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///documents/' },
  Directory: class {},
  File: class {},
}));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => 'id' }));

// One stored entity as the store holds it: its path plus the JSON payload bytes.
function row(path: string, entity: object): { path: string; data: Uint8Array } {
  return { path, data: utf8(JSON.stringify(entity)) };
}

function makeList(id: string, name: string, parentId: string | null, rank: string): List {
  return { id, name, parentId, rank, createdAt: 1, updatedAt: 1 };
}

function makeTag(id: string, name: string, rank: string): Tag {
  return { id, name, parentId: null, rank, createdAt: 1, updatedAt: 1 };
}

function seedLists(lists: List[]): void {
  mockRowsByPrefix.set(
    LISTS_PREFIX,
    lists.map((list) => row(pathFromId(list.id, LISTS_PREFIX), list)),
  );
}

beforeEach(() => {
  mockRowsByPrefix.clear();
});

describe('readLists', () => {
  it('supplies the system defaults when nothing is stored', async () => {
    const lists = await readLists();

    expect(lists.map((list) => list.id)).toEqual(SYSTEM_LIST_DEFAULTS.map((def) => def.id));
    expect(lists.map((list) => list.id)).toEqual(
      expect.arrayContaining([MY_LIST_ID, ARCHIVE_ID, TRASH_ID]),
    );
  });

  it('gives a default a synthesized path, so the UI can target it before it exists', async () => {
    const lists = await readLists();

    const myList = lists.find((list) => list.id === MY_LIST_ID);
    expect(myList?.path).toBe(pathFromId(MY_LIST_ID, LISTS_PREFIX));
  });

  it('lets a stored override win over the default', async () => {
    seedLists([makeList(MY_LIST_ID, 'Inbox', null, SYSTEM_LIST_DEFAULTS[0].rank)]);

    const lists = await readLists();

    // The override replaces the default IN PLACE — renamed, not duplicated, and
    // still ahead of the other system lists.
    expect(lists.filter((list) => list.id === MY_LIST_ID)).toHaveLength(1);
    expect(lists[0]).toMatchObject({ id: MY_LIST_ID, name: 'Inbox' });
  });

  it('appends user lists after the system set', async () => {
    seedLists([makeList('list-a', 'Reading', null, 'a1')]);

    const lists = await readLists();

    expect(lists).toHaveLength(SYSTEM_LIST_DEFAULTS.length + 1);
    expect(lists.at(-1)).toMatchObject({ id: 'list-a', name: 'Reading' });
    // The system ids are still all present alongside it.
    for (const id of SYSTEM_LIST_IDS) {
      expect(lists.some((list) => list.id === id)).toBe(true);
    }
  });

  it('drops an unparseable blob rather than crashing the view', async () => {
    mockRowsByPrefix.set(LISTS_PREFIX, [
      { path: pathFromId('list-bad', LISTS_PREFIX), data: utf8('not json') },
      row(pathFromId('list-a', LISTS_PREFIX), makeList('list-a', 'Reading', null, 'a1')),
    ]);

    const lists = await readLists();

    expect(lists.some((list) => list.id === 'list-bad')).toBe(false);
    expect(lists.some((list) => list.id === 'list-a')).toBe(true);
  });
});

describe('readTags', () => {
  it('returns the stored tags with their paths, and no defaults to merge', async () => {
    mockRowsByPrefix.set(TAGS_PREFIX, [
      row(pathFromId('tag-a', TAGS_PREFIX), makeTag('tag-a', 'alpha', 'a1')),
    ]);

    const tags = await readTags();

    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({
      id: 'tag-a',
      name: 'alpha',
      path: pathFromId('tag-a', TAGS_PREFIX),
    });
  });

  it('is empty when nothing is stored', async () => {
    await expect(readTags()).resolves.toEqual([]);
  });
});

// A list's and a tag's identity is its PATH (shared sync/paths.ts, idFromPath);
// the `id` in its plaintext is a copy that nothing between a backup or another
// device and this store makes agree. Everything downstream goes by the `id` these
// two hand back, so a read edge that passed the copy through let a stored record
// choose its own identity. Web's queries.spec.ts pins the same four cases against
// Dexie.
describe('the id a list or tag is read under', () => {
  const userLists = async () => (await readLists()).filter((list) => !SYSTEM_LIST_IDS.has(list.id));

  it('is the path id, whatever the plaintext says', async () => {
    mockRowsByPrefix.set(LISTS_PREFIX, [
      row(pathFromId('a', LISTS_PREFIX), makeList('claimed', 'A', null, 'a')),
    ]);
    mockRowsByPrefix.set(TAGS_PREFIX, [
      row(pathFromId('t', TAGS_PREFIX), makeTag('claimed', 'T', 'a')),
    ]);

    expect((await userLists()).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'a', name: 'A' },
    ]);
    expect((await readTags()).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 't', name: 'T' },
    ]);
  });

  // The case the rule exists for: two records under one id were both a child of
  // its parent and a parent of its children, so the tree held more nodes than
  // there were lists.
  it('keeps records that claim one id apart, so the tree holds each once', async () => {
    mockRowsByPrefix.set(LISTS_PREFIX, [
      row(pathFromId('a', LISTS_PREFIX), makeList('shared', 'A', null, 'a')),
      row(pathFromId('b', LISTS_PREFIX), makeList('shared', 'B', null, 'b')),
    ]);
    mockRowsByPrefix.set(TAGS_PREFIX, [
      row(pathFromId('c', TAGS_PREFIX), makeTag('shared', 'C', 'a')),
      row(pathFromId('d', TAGS_PREFIX), makeTag('shared', 'D', 'b')),
    ]);

    const lists = await userLists();
    const tags = await readTags();

    expect(lists.map((list) => list.id)).toEqual(['a', 'b']);
    expect(flattenTree(buildTree(lists)).map((node) => node.item.name)).toEqual(['A', 'B']);
    expect(tags.map((tag) => tag.id)).toEqual(['c', 'd']);
    expect(flattenTree(buildTree(tags)).map((node) => node.item.name)).toEqual(['C', 'D']);
  });

  // The merge is by id, so it has to see the path's.
  it('does not take a record stored elsewhere for a system list', async () => {
    mockRowsByPrefix.set(LISTS_PREFIX, [
      row(pathFromId('a', LISTS_PREFIX), makeList(TRASH_ID, 'Not Trash', null, 'a')),
    ]);

    const lists = await readLists();

    expect(lists.find((list) => list.id === TRASH_ID)?.name).toBe(SYSTEM_LIST_NAMES[TRASH_ID]);
    expect(lists.find((list) => list.id === 'a')?.name).toBe('Not Trash');
    expect(lists.filter((list) => list.id === TRASH_ID)).toHaveLength(1);
  });

  it('reads the record at a system path as that list, whatever it calls itself', async () => {
    mockRowsByPrefix.set(LISTS_PREFIX, [
      row(pathFromId(TRASH_ID, LISTS_PREFIX), makeList('claimed', 'Bin', null, 'a')),
    ]);

    const lists = await readLists();

    expect(lists.find((list) => list.id === TRASH_ID)?.name).toBe('Bin');
    expect(lists.some((list) => list.id === 'claimed')).toBe(false);
  });
});

// Two more ids the read edge decides rather than the record — web
// queries.spec.ts has the reasoning: no reader is handed a list at a reserved id,
// and a pin is read under its path's id.
describe('the ids the read edge decides', () => {
  it.each([ALL_ID, APP_LOCK_ID])('hands no reader a list stored at %s', async (id) => {
    mockRowsByPrefix.set(LISTS_PREFIX, [
      row(pathFromId(id, LISTS_PREFIX), makeList(id, 'Reserved', null, 'a')),
      row(pathFromId('a', LISTS_PREFIX), makeList('a', 'Kept', null, 'b')),
    ]);

    const lists = await readLists();

    expect(lists.some((entry) => entry.id === id)).toBe(false);
    expect(lists.find((entry) => entry.id === 'a')?.name).toBe('Kept');
  });

  it('reads a pin under its path id, whatever the plaintext says', async () => {
    mockRowsByPrefix.set(PINS_PREFIX, [
      row(pathFromId('lnk-a', PINS_PREFIX), { id: 'lnk-b', rank: 'a', createdAt: 1, updatedAt: 1 }),
      row(pathFromId('lnk-c', PINS_PREFIX), { id: 'lnk-c', rank: 'b', createdAt: 1, updatedAt: 1 }),
    ]);

    const pins = await readPins();

    expect(pins.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: 'lnk-a', path: pathFromId('lnk-a', PINS_PREFIX) },
      { id: 'lnk-c', path: pathFromId('lnk-c', PINS_PREFIX) },
    ]);
  });
});
