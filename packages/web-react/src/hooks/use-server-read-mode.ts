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
// signed-in, ready store; the server-extraction opt-in (the privacy-load-bearing one —
// no address leaves the browser without it); an extractor configured for this build; and
// a plan with `keptCopies`, since taking a copy is the gated half (reading never is).
// A surface renders the action only while it is true.
export interface ServerReadMode {
  available: boolean;
  keep: (link: LinkItem) => Promise<ServerReadModeOutcome>;
}

export function useServerReadMode(): ServerReadMode {
  const client = useExtractClient();
  const { username } = useAuth();
  const { storeStatus, requestSync } = useSync();
  const { serverExtraction } = useSettings();
  const { entitlements } = useEntitlements();

  const available =
    Boolean(username) &&
    storeStatus === 'ready' &&
    serverExtraction &&
    client !== null &&
    entitlements.keptCopies;

  const keep = useCallback(
    async (link: LinkItem) => {
      if (!username || !client) throw new Error('useServerReadMode: unavailable');
      const outcome = await runServerReadMode(username, link, client);
      if (outcome.kind !== 'exists') requestSync();
      return outcome;
    },
    [username, client, requestSync],
  );

  return useMemo(() => ({ available, keep }), [available, keep]);
}
