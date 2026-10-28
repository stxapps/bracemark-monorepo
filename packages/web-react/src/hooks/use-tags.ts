'use client';

// Reactive read of the user's tags for the sidebar, as an ordered TREE. Mirrors
// useLists, minus the system entries: tags are all user-created, so there's
// nothing to merge and no forbidden parent — buildTree just orders by `rank` and
// nests by `parentId`. A flat tag set comes back as one ranked level.

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import { buildTree, type TreeNode } from '@stxapps/shared';

import { readTags, type TagItem } from '../data/queries';

const NO_TAGS: TreeNode<TagItem>[] = [];

export function useTags(): TreeNode<TagItem>[] {
  return useTagsOrUndefined() ?? NO_TAGS;
}

// The same tree, but `undefined` until the first read lands — for a caller that
// says something about an EMPTY tree, which useTags' `[]` can't tell from a read
// still in flight (the sidebar's "No tags yet", which otherwise opens every
// page load by claiming a tagged library has none).
export function useTagsOrUndefined(): TreeNode<TagItem>[] | undefined {
  const tags = useLiveQuery(() => readTags(), []);
  return useMemo(() => (tags === undefined ? undefined : buildTree(tags)), [tags]);
}
