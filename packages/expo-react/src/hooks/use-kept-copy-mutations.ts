import { useCallback, useMemo } from 'react';

import { keepOnSaveOf } from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { type KeptCopyFacet, removeKeptCopy } from '../data/mutations';
import { linkIdOf, type LinkItem, readSettingsGeneral } from '../data/queries';
import { storeReadModeCopy, type StoreReadModeOptions } from '../data/store-read-mode';

// Keeping and removing copies on expo. Removal is web-react's useKeptCopyMutations
// on expo's store — never gated on the plan, like reading. Keeping (`keepReadMode`)
// is the capture screen's write: the copy its WebView took from the live page,
// stored at the active-page tier (data/store-read-mode.ts). THAT is plan-gated, and
// by the caller — the screen checks `keptCopies` before it captures.

const ALL_KEPT_COPIES: readonly KeptCopyFacet[] = ['readMode', 'screenshot'];

export interface KeptCopyMutations {
  // Store a read-mode copy taken from a live page on this device. Resolves whether
  // it was stored (false for a payload that isn't a ReaderDoc). `fetchFromPage` is the
  // capture screen's in-page image fetch (data/store-read-mode.ts).
  keepReadMode: (
    link: LinkItem,
    doc: unknown,
    options?: Pick<StoreReadModeOptions, 'fetchFromPage'>,
  ) => Promise<boolean>;
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
    async (link: LinkItem, doc: unknown, options?: Pick<StoreReadModeOptions, 'fetchFromPage'>) => {
      if (!username) throw new Error('useKeptCopyMutations: no active account');
      // Whether the copy keeps the article's images is the account's setting, read
      // from the STORE at the ask (a render's copy answers the defaults until it
      // loads). This is an explicit ask on a page the user has open, so it is not
      // subject to the device's fetch mode the way a share's drain is. A read that
      // fails keeps the words only.
      let images = false;
      try {
        images = keepOnSaveOf(await readSettingsGeneral()).readModeImages;
      } catch {
        images = false;
      }
      const stored = await storeReadModeCopy(username, linkIdOf(link), doc, {
        images,
        fetchFromPage: options?.fetchFromPage,
      });
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
