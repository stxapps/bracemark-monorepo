'use client';

// The import-all-data state machine over data/import-all-data.ts — what the
// Settings → Data → Import view renders; the mirror of use-export-all-data.ts.
// One run at a time. On success it kicks the SyncProvider's requestSync so the
// freshly-queued pending ops drain through the normal engine cycle (and the sync
// status card shows it), rather than running a private sync of its own.

import { useCallback, useRef, useState } from 'react';

import { useApiClient } from '@stxapps/react';
import type { ImportOutcome, ImportProgress } from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { importAllData } from '../data/import-all-data';
import { getSession } from '../data/session-store';
import type { SyncDeps } from '../sync/engine';
import { useEntitlements } from './use-entitlements';

export type ImportState =
  | { phase: 'idle' }
  | ({ phase: 'running' } & ImportProgress)
  | { phase: 'done'; outcome: ImportOutcome }
  | { phase: 'error'; message: string };

export interface UseImportAllDataResult {
  state: ImportState;
  // Start an import from the picked file; no-op while one is running. Format is
  // detected from the file itself (zip magic → Bracemark backup, else sniffed text).
  run: (file: File) => void;
}

export function useImportAllData(): UseImportAllDataResult {
  const { username } = useAuth();
  const { requestSync } = useSync();
  const api = useApiClient();
  // The plan gates the orchestrator enforces: the upfront link cap and whether
  // folder paths may create nested lists.
  const { entitlements } = useEntitlements();
  const [state, setState] = useState<ImportState>({ phase: 'idle' });
  // Re-entrancy guard that doesn't wait for the state update to land.
  const runningRef = useRef(false);

  const run = useCallback(
    (file: File) => {
      if (runningRef.current) return;

      const session = getSession();
      if (!username || !session) {
        setState({ phase: 'error', message: 'You must be signed in to import.' });
        return;
      }
      const deps: SyncDeps = { username, encryptionKey: session.encryptionKey, api };

      runningRef.current = true;
      setState({ phase: 'running', step: 'sync' });
      void importAllData({
        file,
        deps,
        maxLinks: entitlements.maxLinks,
        nestedLists: entitlements.nestedLists,
        onProgress: (progress) => setState({ phase: 'running', ...progress }),
      })
        .then(
          (outcome) => {
            setState({ phase: 'done', outcome });
            // Drain the queued ops through the normal cycle (coalesces with any
            // in-flight one) — the imported data starts syncing right away.
            requestSync();
          },
          (err: unknown) => {
            setState({
              phase: 'error',
              message: err instanceof Error ? err.message : String(err),
            });
          },
        )
        .finally(() => {
          runningRef.current = false;
        });
    },
    [username, api, entitlements.maxLinks, entitlements.nestedLists, requestSync],
  );

  return { state, run };
}
