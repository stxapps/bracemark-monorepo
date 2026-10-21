/**
 * @jest-environment jsdom
 */
// Specs for `createTopLevel` — the one create behind every inline "add a list":
// the Lists settings CreateRow, the editors' ListSelect and the link "Move to"
// surfaces all hand it a name and nothing else, so WHERE the list lands is
// decided here and nowhere a host can see (docs/editors.md, _every create lands
// in the same place_). Landing somewhere else is silent: the list exists, the
// link is filed in it, and it is merely not where the last one went.
//
// The reads/writes are stubbed at the data modules; the rank arithmetic and the
// tree are the real code, and each assertion reads back the root group the
// sidebar would render.

import { act, renderHook } from '@testing-library/react';

import { buildTree, LIST_NO_CHILDREN_IDS, TREE_MAX_DEPTH } from '@stxapps/shared';

import type { ListItem } from '../data/queries';
import { useListMutations } from './use-list-mutations';

let mockLists: ListItem[] = [];
let mockNextId = 0;
const mockWriteList = jest.fn(
  (_username: string, list: ListItem, patch: Partial<ListItem>): Promise<void> => {
    mockLists = [...mockLists.filter((l) => l.id !== list.id), { ...list, ...patch }];
    return Promise.resolve();
  },
);

jest.mock('@stxapps/web-crypto', () => ({ newId: () => `new-${++mockNextId}` }));
jest.mock('../contexts/auth-provider', () => ({ useAuth: () => ({ username: 'alice' }) }));
jest.mock('../contexts/sync-provider', () => ({ useSync: () => ({ requestSync: jest.fn() }) }));
jest.mock('../data/mutations', () => ({
  writeList: (username: string, list: ListItem, patch: Partial<ListItem>) =>
    mockWriteList(username, list, patch),
  deleteList: jest.fn(),
}));
jest.mock('../data/queries', () => ({
  readLists: () => Promise.resolve(mockLists.map((l) => ({ ...l }))),
  countLinksInList: () => Promise.resolve(0),
}));

const list = (id: string, rank: string, parentId: string | null = null): ListItem => ({
  id,
  name: id,
  parentId,
  rank,
  createdAt: 1,
  updatedAt: 1,
  path: `lists/${id}.enc`,
});

// The root group as useLists renders it.
const rootOrder = (): string[] =>
  buildTree(mockLists, { noChildrenIds: LIST_NO_CHILDREN_IDS }).map((node) => node.item.id);

beforeEach(() => {
  mockNextId = 0;
  mockWriteList.mockClear();
  mockLists = [list('work', 'a1'), list('cooking', 'a0', 'work'), list('personal', 'a2')];
});

it('lands a new list top-level, at the head of the root group', async () => {
  const { result } = renderHook(() => useListMutations());

  const created = await act(() => result.current.createTopLevel('Groceries'));

  expect(created).toMatchObject({ name: 'Groceries', parentId: null });
  expect(rootOrder()).toEqual(['new-1', 'work', 'personal']);
});

// No host re-renders between these two calls, and neither did the hook: a root
// group captured at render would hand both creates the same head, and so the
// same rank — two lists tied for one slot, ordered by their ids.
it('reads the root group when it is called, not when it rendered', async () => {
  const { result } = renderHook(() => useListMutations());
  const { createTopLevel } = result.current;

  const first = await act(() => createTopLevel('First'));
  const second = await act(() => createTopLevel('Second'));

  expect(second?.rank).not.toBe(first?.rank);
  expect(rootOrder()).toEqual(['new-2', 'new-1', 'work', 'personal']);
});

// A list whose parent is gone — or is Trash, which can't hold lists — renders at
// the root without a null `parentId`. It can be the head, so the root group has
// to be the tree's, not a `parentId === null` filter: that one skips the stray
// and mints the key before "work", which is the stray's own.
it.each([
  ['a parent that no longer exists', 'gone'],
  ['Trash as its parent', [...LIST_NO_CHILDREN_IDS][0]],
])('lands ahead of a head list that has %s', async (_case, parentId) => {
  mockLists = [list('stray', 'a0', parentId), list('work', 'a1')];
  const { result } = renderHook(() => useListMutations());

  const created = await act(() => result.current.createTopLevel('Groceries'));

  expect(rootOrder()).toEqual(['new-1', 'stray', 'work']);
  expect(created && created.rank < 'a0').toBe(true);
});

it('creates nothing from a blank name', async () => {
  const { result } = renderHook(() => useListMutations());

  const created = await act(() => result.current.createTopLevel('   '));

  expect(created).toBeNull();
  expect(mockWriteList).not.toHaveBeenCalled();
});

// `move` asks the depth rule of the store, after the move (shared sync/tree.ts,
// moveDeepensPastMaxDepth), not only through the surfaces, which offer by the
// tree they drew. The specimen is one a `parentId` loop hides: m1 ⇄ m2, with a
// chain hanging off m2 whose top the cut detaches, so it reads as a root of its
// own. Move up on m1's root row writes its effective parent, null — which would
// take the loop out and hang the chain under m2, past the limit.
it('refuses a move that would take a list past the depth limit, and writes nothing', async () => {
  const chain = Array.from({ length: TREE_MAX_DEPTH - 2 }, (_, i) =>
    list(`z${i}`, 'a0', i === 0 ? 'a' : `z${i - 1}`),
  );
  mockLists = [list('m1', 'a0', 'm2'), list('m2', 'a0', 'm1'), list('a', 'a1', 'm2'), ...chain];
  const { result } = renderHook(() => useListMutations());

  await expect(
    act(() => result.current.move(mockLists[0], null, [mockLists[2]], 1)),
  ).rejects.toThrow(`Moving “m1” there would nest lists more than ${TREE_MAX_DEPTH} levels deep.`);
  expect(mockWriteList).not.toHaveBeenCalled();

  // One list shorter, and the same move goes through.
  mockLists = mockLists.filter((l) => l.id !== `z${TREE_MAX_DEPTH - 3}`);
  await act(() => result.current.move(mockLists[0], null, [mockLists[2]], 1));
  expect(mockWriteList).toHaveBeenCalledTimes(1);
});
