// Reactive read of the user's lists for the sidebar, as an ordered TREE — the
// expo sibling of web-react's use-lists (see there): readLists merges the
// system-list defaults with the user's synced lists, and buildTree turns that
// flat set into a forest ordered by `rank` and nested by `parentId`. Trash
// can't be a parent (LIST_NO_CHILDREN_IDS), so anything pointing at it falls
// back to the root. Live over `items` via useLiveRead (lists are items rows).

import { useMemo } from 'react';

import { buildTree, LIST_NO_CHILDREN_IDS, type ListItem, type TreeNode } from '@stxapps/shared';

import { readLists } from '../data/queries';
import { useLiveRead } from './use-live-read';

export function useLists(): TreeNode<ListItem>[] {
  const lists = useLiveRead(() => readLists(), [], ['items']);
  return useMemo(() => buildTree(lists ?? [], { noChildrenIds: LIST_NO_CHILDREN_IDS }), [lists]);
}
