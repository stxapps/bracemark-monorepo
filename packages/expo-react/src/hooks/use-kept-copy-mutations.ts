import { useCallback, useMemo } from 'react';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { type KeptCopyFacet, removeKeptCopy } from '../data/mutations';
import { linkIdOf, type LinkItem } from '../data/queries';

// Removing kept copies — web-react's useKeptCopyMutations, on expo's store. Never
// gated on the plan, like reading.

const ALL_KEPT_COPIES: readonly KeptCopyFacet[] = ['readMode', 'screenshot'];

export interface KeptCopyMutations {
  removeCopy: (link: LinkItem, facet: KeptCopyFacet) => Promise<boolean>;
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
