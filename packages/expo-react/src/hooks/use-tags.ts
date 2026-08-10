// Reactive read of the user's tags for the sidebar, as an ordered TREE — the
// expo sibling of web-react's use-tags: mirrors useLists minus the system
// entries (tags are all user-created, so there's nothing to merge and no
// forbidden parent). A flat tag set comes back as one ranked level.

import { useMemo } from 'react';

import { buildTree, type TagItem, type TreeNode } from '@stxapps/shared';

import { readTags } from '../data/queries';
import { useLiveRead } from './use-live-read';

export function useTags(): TreeNode<TagItem>[] {
  const tags = useLiveRead(() => readTags(), [], ['items']);
  return useMemo(() => buildTree(tags ?? []), [tags]);
}
