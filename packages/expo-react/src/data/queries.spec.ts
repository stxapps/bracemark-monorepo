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
// Only the row scan is stubbed: `namespaceRows` (item-store.ts) stands in for
// sqlite, everything above it — decode, parseBlob, the merge — runs for real.

import {
  ARCHIVE_ID,
  type List,
  LISTS_PREFIX,
  MY_LIST_ID,
  pathFromId,
  SYSTEM_LIST_DEFAULTS,
  SYSTEM_LIST_IDS,
  type Tag,
  TAGS_PREFIX,
  TRASH_ID,
  utf8,
} from '@stxapps/shared';

import { readLists, readTags } from './queries';

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
