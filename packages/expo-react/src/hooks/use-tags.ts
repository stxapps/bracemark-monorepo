// Reactive read of the user's tags for the sidebar, as an ordered TREE — the
// expo sibling of web-react's use-tags: mirrors useLists minus the system
// entries (tags are all user-created, so there's nothing to merge and no
// forbidden parent). A flat tag set comes back as one ranked level.

import { useMemo } from 'react';

import { buildTree, type TagItem, type TreeNode } from '@stxapps/shared';

import { readTags } from '../data/queries';
import { useLiveRead } from './use-live-read';

const NO_TAGS: TreeNode<TagItem>[] = [];

export function useTags(): TreeNode<TagItem>[] {
  return useTagsOrUndefined() ?? NO_TAGS;
}

// The same tree, but `undefined` until the first read lands — for a caller that
// says something about an EMPTY tree, which useTags' `[]` can't tell from a read
// still in flight (the sidebar's "No tags yet", which otherwise opens every
// mount by claiming a tagged library has none).
export function useTagsOrUndefined(): TreeNode<TagItem>[] | undefined {
  const tags = useLiveRead(() => readTags(), [], ['items']);
  return useMemo(() => (tags === undefined ? undefined : buildTree(tags)), [tags]);
}
