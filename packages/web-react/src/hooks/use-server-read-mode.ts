'use client';

import { useCallback, useMemo } from 'react';

import { useExtractClient } from '@stxapps/react';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { type LinkItem } from '../data/queries';
import { runServerReadMode, type ServerReadModeOutcome } from '../lib/server-read-mode';
import { useEntitlements } from './use-entitlements';
import { useSettings } from './use-settings';

// Keep one link's read-mode copy through bracemark-extractor — the web app's only way to
// take a copy (lib/server-read-mode.ts). `available` is every condition at once: a
// signed-in, ready store; the `serverReadMode` opt-in (the privacy-load-bearing one —
// no address leaves the browser without it); an extractor configured for this build; and
// a plan with `keptCopies`, since taking a copy is the gated half (reading never is).
// A surface renders the action only while it is true.
//
// The opt-in is `serverReadMode`, NOT `serverExtraction`: the preview opt-in sends
// every pending link as it comes into view, and asking for it to keep one article
// made a single copy cost the whole un-gestured drain (entities.ts).
//
// `needsOptIn` is every condition but the opt-in — the moment a surface can offer to
// turn it on and have the action work straight after. Kept separate from `available`
// so a surface never offers a switch whose action would still be missing (no
// extractor in this build, a store not ready, a plan without `keptCopies`).
export interface ServerReadMode {
  available: boolean;
  needsOptIn: boolean;
  keep: (link: LinkItem) => Promise<ServerReadModeOutcome>;
}

export function useServerReadMode(): ServerReadMode {
  const client = useExtractClient();
  const { username } = useAuth();
  const { storeStatus, requestSync } = useSync();
  const { serverReadMode } = useSettings();
  const { entitlements } = useEntitlements();

  const ready =
    Boolean(username) && storeStatus === 'ready' && client !== null && entitlements.keptCopies;
  const available = ready && serverReadMode;
  const needsOptIn = ready && !serverReadMode;

  const keep = useCallback(
    async (link: LinkItem) => {
      if (!username || !client) throw new Error('useServerReadMode: unavailable');
      const outcome = await runServerReadMode(username, link, client);
      if (outcome.kind !== 'exists') requestSync();
      return outcome;
    },
    [username, client, requestSync],
  );

  return useMemo(() => ({ available, needsOptIn, keep }), [available, needsOptIn, keep]);
}
