'use client';

// Reactive read of the user's lists for the sidebar, as an ordered TREE. Live
// over `items` like useLinks; readLists merges the system-list defaults with the
// user's synced lists, and buildTree turns that flat set into a forest ordered by
// `rank` and nested by `parentId`. Trash can't be a parent (LIST_NO_CHILDREN_IDS),
// so anything pointing at it falls back to the root.

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { buildTree, LIST_NO_CHILDREN_IDS, type TreeNode } from '@stxapps/shared';

import { type ListItem, readLists } from '../data/queries';

export function useLists(): TreeNode<ListItem>[] {
  const lists = useLiveQuery(() => readLists(), []);
  return useMemo(() => buildTree(lists ?? [], { noChildrenIds: LIST_NO_CHILDREN_IDS }), [lists]);
}
