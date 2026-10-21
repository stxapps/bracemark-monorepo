// Edit operations for lists — create, rename, reorder, reparent, delete — the
// expo sibling of web-react's hooks/use-list-mutations.ts, verbatim in contract
// (see there for the rank/parentId model rationale: each op writes exactly ONE
// list file, so concurrent moves on two devices don't collide). Only the
// platform seams differ: expo-crypto's newId and this package's data layer.

import { useCallback, useMemo } from 'react';

import { newId } from '@stxapps/expo-crypto';
import {
  buildTree,
  cleanName,
  isSystemListId,
  LIST_NAME_MAX,
  LIST_NO_CHILDREN_IDS,
  LISTS_PREFIX,
  moveDeepensPastMaxDepth,
  pathFromId,
  placeAtIndex,
  rankForIndex,
  rerankToOrder,
  TRASH_ID,
  TREE_MAX_DEPTH,
} from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { deleteList, writeList } from '../data/mutations';
import { countLinksInList, type ListItem, readLists } from '../data/queries';

export interface ListMutations {
  // Create a list and place it at `index` within `parentId`'s children. Mirrors
  // `move`'s positioning contract: `siblings` is the destination group as
  // currently ordered (the new list isn't in it yet, so nothing to exclude).
  // Returns the created list so the UI can focus/scroll to its new row. A blank
  // name is a no-op (returns null).
  create: (
    name: string,
    parentId: string | null,
    siblings: ListItem[],
    index: number,
  ) => Promise<ListItem | null>;
  // `create` with the position every inline "add a list" uses: TOP-LEVEL
  // (`parentId: null`) at the head of the root group — the Lists settings
  // CreateRow, ListSelect's Create row and the link "Move to" surfaces all land
  // here, so the same action puts the list in the same place wherever it's
  // invoked (docs/editors.md). Takes only a name, like
  // useTagMutations.findOrCreate: the root group is read from the store at call
  // time, so a host holds no live list read for it. Resolves to the new list,
  // for the host to select or move into; null for a blank name.
  createTopLevel: (name: string) => Promise<ListItem | null>;
  rename: (list: ListItem, name: string) => Promise<void>;
  // Place `list` at `index` within `parentId`'s children. `siblings` is that
  // destination group as currently ordered, EXCLUDING `list` itself (so an
  // in-group reorder passes the group minus the moved row). `parentId` is null
  // for the root.
  move: (
    list: ListItem,
    parentId: string | null,
    siblings: ListItem[],
    index: number,
  ) => Promise<void>;
  // Permanently delete a list (no trash for lists — irreversible, like
  // useLinkMutations.destroy). Rejected for system lists, and for any list that
  // still has sub-lists or links — deleting it would orphan them, so the UI must
  // empty it first. Throws `destroyBlocker`'s sentence, which is meant to surface
  // to the user.
  destroy: (list: ListItem) => Promise<void>;
  // Why `destroy` would refuse `list` right now, as the sentence to show — or
  // null when it would go through. The same guards, read fresh from the store,
  // so a UI can ask BEFORE it offers a confirm instead of reporting the refusal
  // after it. Advisory only: another device can add a link between this read and
  // the delete, which is why `destroy` asks again rather than trusting a caller
  // that checked.
  destroyBlocker: (list: ListItem) => Promise<string | null>;
  // Re-rank a sibling group into a new order in one batch (e.g. sort A→Z).
  // `ordered` is the group as it should end up; only the lists whose rank
  // actually changes are written, each the same one-field `{ rank }` write
  // `move` makes — so an already-ordered group is a no-op and a partial sort
  // touches the fewest files.
  reorder: (ordered: ListItem[]) => Promise<void>;
}

export function useListMutations(): ListMutations {
  const { username } = useAuth();
  const { requestSync } = useSync();

  const create = useCallback(
    async (name: string, parentId: string | null, siblings: ListItem[], index: number) => {
      if (!username) throw new Error('useListMutations: no active account');
      if (parentId === TRASH_ID) throw new Error('Trash cannot contain lists');

      const trimmed = cleanName(name, LIST_NAME_MAX);
      if (trimmed === '') return null;

      const id = newId();
      // createdAt: 0 → writeList stamps it now, exactly like the first edit of a
      // system-list default; path is the well-known store key its blob will live at.
      const list: ListItem = {
        id,
        name: trimmed,
        parentId,
        rank: rankForIndex(siblings, index),
        createdAt: 0,
        updatedAt: 0,
        path: pathFromId(id, LISTS_PREFIX),
      };

      await writeList(username, list, {});
      requestSync();
      return list;
    },
    [username, requestSync],
  );

  const createTopLevel = useCallback(
    async (name: string) => {
      if (!username) throw new Error('useListMutations: no active account');
      if (name.trim() === '') return null;

      // Re-derive the root group from the store rather than a rendered snapshot:
      // a second create can be confirmed before the live read has caught up with
      // the first, and against a stale head both would mint the same rank.
      // buildTree, not a `parentId === null` filter — it is what useLists
      // renders, and it drops a list whose parent is gone (or is Trash) back to
      // the root, where it can be the head this has to land before.
      const root = buildTree(await readLists(), { noChildrenIds: LIST_NO_CHILDREN_IDS });
      return create(
        name,
        null,
        root.map((node) => node.item),
        0,
      );
    },
    [username, create],
  );

  const rename = useCallback(
    async (list: ListItem, name: string) => {
      if (!username) throw new Error('useListMutations: no active account');

      // An unedited name is no rename, however long: one stored before the cap
      // (LIST_NAME_MAX) is cut only when the user changes it.
      if (name.trim() === list.name) return;
      const trimmed = cleanName(name, LIST_NAME_MAX);
      if (trimmed === '' || trimmed === list.name) return;

      await writeList(username, list, { name: trimmed });
      requestSync();
    },
    [username, requestSync],
  );

  const move = useCallback(
    async (list: ListItem, parentId: string | null, siblings: ListItem[], index: number) => {
      if (!username) throw new Error('useListMutations: no active account');
      if (parentId === TRASH_ID) throw new Error('Trash cannot contain lists');
      if (parentId === list.id) throw new Error('A list cannot be its own parent');
      // Asked of the store, not of the tree the caller drew: the picker and the
      // drag offer by that forest, which sync can change before the pick, and
      // which cannot show what a move reattaches (moveDeepensPastMaxDepth).
      const lists = await readLists();
      if (
        moveDeepensPastMaxDepth(lists, list.id, parentId, { noChildrenIds: LIST_NO_CHILDREN_IDS })
      ) {
        throw new Error(tooDeep(list.name));
      }

      // One write, unless the slot falls between two tied ranks — then the tied
      // siblings on one side are re-keyed first to open it (placeAtIndex).
      const { rank, shifted } = placeAtIndex(siblings, index);
      for (const sibling of shifted) {
        await writeList(username, sibling.item, { rank: sibling.rank });
      }
      await writeList(username, list, { parentId, rank });
      requestSync();
    },
    [username, requestSync],
  );

  const destroyBlocker = useCallback(async (list: ListItem) => {
    if (isSystemListId(list.id)) return `“${list.name}” is built in, so it can’t be deleted.`;

    // Re-derive emptiness from the store rather than trusting the caller's view,
    // and name + count in the sentence — web's twin carries the reasoning for both.
    const lists = await readLists();
    const subLists = lists.filter((other) => other.parentId === list.id).length;
    if (subLists > 0) return stillHas(list.name, subLists, 'sub-list');
    const links = await countLinksInList(list.id);
    if (links > 0) return stillHas(list.name, links, 'link');
    return null;
  }, []);

  const destroy = useCallback(
    async (list: ListItem) => {
      if (!username) throw new Error('useListMutations: no active account');

      const blocker = await destroyBlocker(list);
      if (blocker) throw new Error(blocker);

      await deleteList(username, list);
      requestSync();
    },
    [username, requestSync, destroyBlocker],
  );

  const reorder = useCallback(
    async (ordered: ListItem[]) => {
      if (!username) throw new Error('useListMutations: no active account');

      const ranks = rerankToOrder(ordered);

      // Sequential, not Promise.all: each writeList opens its own transaction,
      // and expo-sqlite serializes writes on the single connection anyway. A
      // handful of siblings makes this cheap.
      let wrote = false;
      for (let i = 0; i < ordered.length; i++) {
        const rank = ranks[i];
        if (rank === null) continue;
        await writeList(username, ordered[i], { rank });
        wrote = true;
      }
      if (wrote) requestSync();
    },
    [username, requestSync],
  );

  return useMemo<ListMutations>(
    () => ({ create, createTopLevel, rename, move, destroy, destroyBlocker, reorder }),
    [create, createTopLevel, rename, move, destroy, destroyBlocker, reorder],
  );
}

// The move refusal, in the same shape: what is wrong, then the act.
function tooDeep(name: string): string {
  return `Moving “${name}” there would nest lists more than ${TREE_MAX_DEPTH} levels deep. Choose a place higher up.`;
}

// "“Reading” still has 3 links. Move or delete them first." — what is wrong,
// then the act (docs/brand-assets.md, _errors have a fixed shape_).
function stillHas(name: string, count: number, noun: string): string {
  return count === 1
    ? `“${name}” still has 1 ${noun}. Move or delete it first.`
    : `“${name}” still has ${count} ${noun}s. Move or delete them first.`;
}
