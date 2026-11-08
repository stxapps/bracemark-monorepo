'use client';

import { useCallback, useMemo } from 'react';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { type KeptCopyFacet, removeKeptCopy } from '../data/mutations';
import { linkIdOf, type LinkItem } from '../data/queries';

// Removing kept copies — one copy of one link (the reader's "Delete this copy"), or
// every copy of a selection (bulk edit's "Delete kept copies"). Both sit on
// `removeKeptCopy` (data/mutations.ts), which drops the ref, marks the facet removed
// so nothing automatic takes it again, and deletes the blob on every device once the
// sync pushes. docs/link-extraction-keep.md, _removal, cleanup, export_.
//
// Never gated on the plan, like reading: a copy taken while entitled stays the
// user's to delete after a downgrade.

const ALL_KEPT_COPIES: readonly KeptCopyFacet[] = ['readMode', 'screenshot'];

export interface KeptCopyMutations {
  // Remove one copy of one link. Resolves whether anything was removed.
  removeCopy: (link: LinkItem, facet: KeptCopyFacet) => Promise<boolean>;
  // Remove every kept copy of each link. Resolves how many copies were removed —
  // links without copies cost a read and no write.
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
      let count = 0;
      for (const link of links) {
        for (const facet of ALL_KEPT_COPIES) {
          if (await removeKeptCopy(username, linkIdOf(link), facet)) count += 1;
        }
      }
      if (count > 0) requestSync();
      return count;
    },
    [username, requestSync],
  );

  return useMemo(() => ({ removeCopy, removeAllCopies }), [removeCopy, removeAllCopies]);
}
