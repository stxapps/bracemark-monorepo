'use client';

import { useCallback, useMemo } from 'react';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { type KeptCopyFacet, removeKeptCopies, removeKeptCopy } from '../data/mutations';
import { linkIdOf, type LinkItem } from '../data/queries';

// Removing kept copies — one copy of one link (the reader's "Delete this copy"), or
// every copy of a selection (bulk edit's "Delete copies"). They sit on
// `removeKeptCopy` and its batched twin `removeKeptCopies` (data/mutations.ts), which
// drop the ref, mark the facet removed so nothing automatic takes it again, and
// delete the blob on every device once the sync pushes — the selection in one write,
// not one per copy. docs/link-extraction-keep.md, _removal, cleanup, export_.
//
// Never gated on the plan, like reading: a copy taken while entitled stays the
// user's to delete after a downgrade.

const ALL_KEPT_COPIES: readonly KeptCopyFacet[] = ['readMode', 'screenshot'];

export interface KeptCopyMutations {
  // Remove one copy of one link. Resolves whether anything was removed.
  removeCopy: (link: LinkItem, facet: KeptCopyFacet) => Promise<boolean>;
  // Remove every kept copy of each link, in one write. Resolves how many copies were
  // removed — links without copies are read and not written.
  removeAllCopies: (links: readonly LinkItem[]) => Promise<number>;
}

export function useKeptCopyMutations(): KeptCopyMutations {
  const { username } = useAuth();
  const { requestSync } = useSync();

  const removeCopy = useCallback(
    async (link: LinkItem, facet: KeptCopyFacet) => {
      if (!username) throw new Error('useKeptCopyMutations: no active account');
      const removed = await removeKeptCopy(username, linkIdOf(link), facet);
      if (removed) requestSync();
      return removed;
    },
    [username, requestSync],
  );

  const removeAllCopies = useCallback(
    async (links: readonly LinkItem[]) => {
      if (!username) throw new Error('useKeptCopyMutations: no active account');
      const count = await removeKeptCopies(username, links.map(linkIdOf), ALL_KEPT_COPIES);
      if (count > 0) requestSync();
      return count;
    },
    [username, requestSync],
  );

  return useMemo(() => ({ removeCopy, removeAllCopies }), [removeCopy, removeAllCopies]);
}
