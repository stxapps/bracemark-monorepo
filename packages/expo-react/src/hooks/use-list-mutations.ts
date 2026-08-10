// Edit operations for lists — create, rename, reorder, reparent, delete — the
// expo sibling of web-react's hooks/use-list-mutations.ts, verbatim in contract
// (see there for the rank/parentId model rationale: each op writes exactly ONE
// list file, so concurrent moves on two devices don't collide). Only the
// platform seams differ: expo-crypto's newId and this package's data layer.

import { useCallback, useMemo } from 'react';

import { newId } from '@stxapps/expo-crypto';
import {
  isSystemListId,
  LISTS_PREFIX,
  pathFromId,
  rankForIndex,
  rerankToOrder,
  TRASH_ID,
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
  // empty it first. The thrown message is meant to surface to the user.
  destroy: (list: ListItem) => Promise<void>;
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

      const trimmed = name.trim();
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

  const rename = useCallback(
    async (list: ListItem, name: string) => {
      if (!username) throw new Error('useListMutations: no active account');

      const trimmed = name.trim();
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

      await writeList(username, list, { parentId, rank: rankForIndex(siblings, index) });
      requestSync();
    },
    [username, requestSync],
  );

  const destroy = useCallback(
    async (list: ListItem) => {
      if (!username) throw new Error('useListMutations: no active account');
      if (isSystemListId(list.id)) throw new Error('System lists cannot be deleted');

      // Re-derive emptiness from the store rather than trusting the caller's view:
      // a sub-list could have been created on another device since the tree
      // rendered. Children first (a cheap namespace read), then the link count.
      const lists = await readLists();
      if (lists.some((other) => other.parentId === list.id)) {
        throw new Error('Move or delete its sub-lists first');
      }
      if ((await countLinksInList(list.id)) > 0) {
        throw new Error('Move or delete its links first');
      }

      await deleteList(username, list);
      requestSync();
    },
    [username, requestSync],
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
    () => ({ create, rename, move, destroy, reorder }),
    [create, rename, move, destroy, reorder],
  );
}
