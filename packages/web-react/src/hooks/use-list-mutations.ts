'use client';

// Edit operations for lists — create, rename, reorder, reparent, delete — bound
// to the active account and wired to a sync kick. Each op writes exactly ONE list
// file (writeList) or deletes one (deleteList), which is the whole point of the
// rank/parentId model: moving a list never rewrites its siblings, so concurrent
// moves on two devices don't collide.
//
// Reorder and move are the same write (a new `rank`, optionally a new `parentId`);
// "reorder" is just "move within the same parent". The caller supplies the
// destination sibling group and target index; placeAtIndex turns that into the
// key to persist. The one exception to ONE file is a slot between two siblings
// whose ranks TIE (two devices created at the same slot): no key fits between
// equal keys, so the tied siblings on one side are re-keyed too (sync/rank.ts).
// Trash can't be a parent and a list can't be its own parent — both rejected
// here, and buildTree is the read-time safety net for any cross-device cycle
// that slips through.

import { useCallback, useMemo } from 'react';

import {
  isSystemListId,
  LISTS_PREFIX,
  pathFromId,
  placeAtIndex,
  rankForIndex,
  rerankToOrder,
  TRASH_ID,
} from '@stxapps/shared';
import { newId } from '@stxapps/web-crypto';

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

    // Re-derive emptiness from the store rather than trusting the caller's view:
    // a sub-list could have been created on another device since the tree
    // rendered. Children first (a cheap namespace read), then the link count.
    //
    // The sentence names the list and counts what's in it, because it is read
    // in a dialog or a notice, not beside the row — "Move or delete its links
    // first" left the reader to work out whose.
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

      // Sequential, not Promise.all: each writeList opens its own rw transaction,
      // and concurrent transactions on the same stores would just serialize
      // anyway. A handful of siblings makes this cheap.
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
    () => ({ create, rename, move, destroy, destroyBlocker, reorder }),
    [create, rename, move, destroy, destroyBlocker, reorder],
  );
}

// "“Reading” still has 3 links. Move or delete them first." — what is wrong,
// then the act (docs/brand-assets.md, _errors have a fixed shape_).
function stillHas(name: string, count: number, noun: string): string {
  return count === 1
    ? `“${name}” still has 1 ${noun}. Move or delete it first.`
    : `“${name}” still has ${count} ${noun}s. Move or delete them first.`;
}
