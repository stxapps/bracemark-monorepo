import { useCallback, useMemo } from 'react';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { type KeptCopyFacet, removeKeptCopy } from '../data/mutations';
import { linkIdOf, type LinkItem } from '../data/queries';
import { storeReadModeCopy } from '../data/store-read-mode';

// Keeping and removing copies on expo. Removal is web-react's useKeptCopyMutations
// on expo's store — never gated on the plan, like reading. Keeping (`keepReadMode`)
// is the capture screen's write: the copy its WebView took from the live page,
// stored at the active-page tier (data/store-read-mode.ts). THAT is plan-gated, and
// by the caller — the screen checks `keptCopies` before it captures.

const ALL_KEPT_COPIES: readonly KeptCopyFacet[] = ['readMode', 'screenshot'];

export interface KeptCopyMutations {
  // Store a read-mode copy taken from a live page on this device. Resolves whether
  // it was stored (false for a payload that isn't a ReaderDoc).
  keepReadMode: (link: LinkItem, doc: unknown) => Promise<boolean>;
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

  const keepReadMode = useCallback(
    async (link: LinkItem, doc: unknown) => {
      if (!username) throw new Error('useKeptCopyMutations: no active account');
      const stored = await storeReadModeCopy(username, linkIdOf(link), doc);
      if (stored) requestSync();
      return stored;
    },
    [username, requestSync],
  );

  return useMemo(
    () => ({ keepReadMode, removeCopy, removeAllCopies }),
    [keepReadMode, removeCopy, removeAllCopies],
  );
}
