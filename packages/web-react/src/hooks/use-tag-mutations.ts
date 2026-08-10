'use client';

// Edit operations for tags — create, rename, reorder, reparent, delete — the tag
// sibling of useListMutations, on the same one-file-per-entity LWW tree (each op
// writes exactly one `tags/{id}.enc` via writeTag, or deletes one, then kicks a
// sync). The rank/parentId model is the point: moving a tag never rewrites its
// siblings, so concurrent moves on two devices don't collide.
//
// Tags differ from lists in two ways that show up below: there are NO system
// tags (every tag is user-created, so nothing is undeletable and nothing needs
// merging), and a link's `tagIds` reference is allowed to dangle (a deleted tag
// is skipped at read time — entities.ts), so deleting a tag needs no link guard
// the way deleteList does. `findOrCreate` is the link editor's reuse-or-mint
// entry point, layered on `create`.

import { useCallback, useMemo } from 'react';

import { compareRank, pathFromId, rankForIndex, rerankToOrder, TAGS_PREFIX } from '@stxapps/shared';
import { newId } from '@stxapps/web-crypto';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { deleteTag, writeTag } from '../data/mutations';
import { readTags, type TagItem } from '../data/queries';

export interface TagMutations {
  // Create a tag and place it at `index` within `parentId`'s children. Mirrors
  // useListMutations.create: `siblings` is the destination group as currently
  // ordered (the new tag isn't in it yet). Returns the created tag; a blank name
  // is a no-op (returns null).
  create: (
    name: string,
    parentId: string | null,
    siblings: TagItem[],
    index: number,
  ) => Promise<TagItem | null>;
  // Reuse-or-mint by name: return the existing tag whose name matches (case-
  // insensitive), else create a new top-level tag prepended to the root group.
  // This is what keeps the link editor's free-text "Add tag" from forking a
  // duplicate entity every time someone retypes a tag they already have. A blank
  // name is a no-op (returns null).
  findOrCreate: (name: string) => Promise<TagItem | null>;
  rename: (tag: TagItem, name: string) => Promise<void>;
  // Place `tag` at `index` within `parentId`'s children. `siblings` is that
  // destination group as currently ordered, EXCLUDING `tag` itself (so an
  // in-group reorder passes the group minus the moved row). `parentId` is null
  // for the root.
  move: (
    tag: TagItem,
    parentId: string | null,
    siblings: TagItem[],
    index: number,
  ) => Promise<void>;
  // Permanently delete a tag (no trash for tags — irreversible, like
  // useLinkMutations.destroy). Rejected only for a tag that still has sub-tags —
  // deleting it would silently re-root them (buildTree promotes orphans), so the
  // UI must move them first. No system-tag guard (none exist) and no link guard
  // (a dangling tagIds reference is normal). The thrown message surfaces to the user.
  destroy: (tag: TagItem) => Promise<void>;
  // Re-rank a sibling group into a new order in one batch (e.g. sort A→Z). Only
  // the tags whose rank actually changes are written, each the same one-field
  // `{ rank }` write `move` makes — so an already-ordered group is a no-op.
  reorder: (ordered: TagItem[]) => Promise<void>;
}

export function useTagMutations(): TagMutations {
  const { username } = useAuth();
  const { requestSync } = useSync();

  const create = useCallback(
    async (name: string, parentId: string | null, siblings: TagItem[], index: number) => {
      if (!username) throw new Error('useTagMutations: no active account');

      const trimmed = name.trim();
      if (trimmed === '') return null;

      const id = newId();
      // createdAt: 0 → writeTag stamps it now, exactly like useListMutations.create;
      // path is the well-known store key its blob will live at.
      const tag: TagItem = {
        id,
        name: trimmed,
        parentId,
        rank: rankForIndex(siblings, index),
        createdAt: 0,
        updatedAt: 0,
        path: pathFromId(id, TAGS_PREFIX),
      };

      await writeTag(username, tag, {});
      requestSync();
      return tag;
    },
    [username, requestSync],
  );

  const findOrCreate = useCallback(
    async (name: string) => {
      if (!username) throw new Error('useTagMutations: no active account');

      const trimmed = name.trim();
      if (trimmed === '') return null;

      // Re-derive from the store rather than a rendered snapshot: a tag with this
      // name could have been created on another device since the form opened.
      const tags = await readTags();
      const match = tags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
      if (match) return match;

      // New top-level tag at index 0 — where the Tags settings CreateRow and
      // ListSelect's create both put a new node, so the same action lands the
      // same place wherever it's invoked. Still sorted: rankForIndex reads the
      // group's head to mint a key before it. Several tags typed in one session
      // therefore stack newest-first (a, b, c → c, b, a) — recency order, and
      // each lands where the eye already is rather than off the end of the list.
      const root = tags.filter((t) => t.parentId === null).sort(compareRank);
      return create(trimmed, null, root, 0);
    },
    [username, create],
  );

  const rename = useCallback(
    async (tag: TagItem, name: string) => {
      if (!username) throw new Error('useTagMutations: no active account');

      const trimmed = name.trim();
      if (trimmed === '' || trimmed === tag.name) return;

      await writeTag(username, tag, { name: trimmed });
      requestSync();
    },
    [username, requestSync],
  );

  const move = useCallback(
    async (tag: TagItem, parentId: string | null, siblings: TagItem[], index: number) => {
      if (!username) throw new Error('useTagMutations: no active account');
      if (parentId === tag.id) throw new Error('A tag cannot be its own parent');

      await writeTag(username, tag, { parentId, rank: rankForIndex(siblings, index) });
      requestSync();
    },
    [username, requestSync],
  );

  const destroy = useCallback(
    async (tag: TagItem) => {
      if (!username) throw new Error('useTagMutations: no active account');

      // Re-derive emptiness from the store rather than trusting the caller's
      // view: a sub-tag could have been created on another device since the tree
      // rendered. No link guard — a link's dangling tagIds is reconciled at read
      // time (entities.ts), unlike a list that must shed its links first.
      const tags = await readTags();
      if (tags.some((other) => other.parentId === tag.id)) {
        throw new Error('Move or delete its sub-tags first');
      }

      await deleteTag(username, tag);
      requestSync();
    },
    [username, requestSync],
  );

  const reorder = useCallback(
    async (ordered: TagItem[]) => {
      if (!username) throw new Error('useTagMutations: no active account');

      const ranks = rerankToOrder(ordered);

      // Sequential, not Promise.all: each writeTag opens its own rw transaction,
      // and concurrent transactions on the same stores would just serialize
      // anyway. A handful of siblings makes this cheap.
      let wrote = false;
      for (let i = 0; i < ordered.length; i++) {
        const rank = ranks[i];
        if (rank === null) continue;
        await writeTag(username, ordered[i], { rank });
        wrote = true;
      }
      if (wrote) requestSync();
    },
    [username, requestSync],
  );

  return useMemo<TagMutations>(
    () => ({ create, findOrCreate, rename, move, destroy, reorder }),
    [create, findOrCreate, rename, move, destroy, reorder],
  );
}
