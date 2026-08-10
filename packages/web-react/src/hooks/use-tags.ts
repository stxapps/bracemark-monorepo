'use client';

// Reactive read of the user's tags for the sidebar, as an ordered TREE. Mirrors
// useLists, minus the system entries: tags are all user-created, so there's
// nothing to merge and no forbidden parent — buildTree just orders by `rank` and
// nests by `parentId`. A flat tag set comes back as one ranked level.

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { buildTree, type TreeNode } from '@stxapps/shared';

import { readTags, type TagItem } from '../data/queries';

export function useTags(): TreeNode<TagItem>[] {
  const tags = useLiveQuery(() => readTags(), []);
  return useMemo(() => buildTree(tags ?? []), [tags]);
}
