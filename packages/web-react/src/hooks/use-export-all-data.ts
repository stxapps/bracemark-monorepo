'use client';

// The export-all-data state machine over data/export-all-data.ts — what the
// Settings → Data → Export view renders. One run at a time; a run that ends in
// the user dismissing the save dialog (ExportCancelledError) returns to `idle`
// rather than surfacing an error, since nothing failed.

import { useCallback, useRef, useState } from 'react';

import { useApiClient } from '@stxapps/react';

import { useAuth } from '../contexts/auth-provider';
import {
  exportAllData,
  ExportCancelledError,
  type ExportFormat,
  type ExportOutcome,
  type ExportProgress,
} from '../data/export-all-data';
import { getSession } from '../data/session-store';
import type { SyncDeps } from '../sync/engine';

export type ExportState =
  | { phase: 'idle' }
  | ({ phase: 'running' } & ExportProgress)
  | { phase: 'done'; outcome: ExportOutcome }
  | { phase: 'error'; message: string };

export interface UseExportAllDataResult {
  state: ExportState;
  // Start an export; no-op while one is running. `excludedListIds` is the lock
  // coverage set (useLocks().lockedListIds) — the caller passes it so this hook
  // doesn't need to mount under LockProvider.
  run: (format: ExportFormat, excludedListIds: ReadonlySet<string>) => void;
}

export function useExportAllData(): UseExportAllDataResult {
  const { username } = useAuth();
  const api = useApiClient();
  const [state, setState] = useState<ExportState>({ phase: 'idle' });
  // Re-entrancy guard that doesn't wait for the state update to land.
  const runningRef = useRef(false);

  const run = useCallback(
    (format: ExportFormat, excludedListIds: ReadonlySet<string>) => {
      if (runningRef.current) return;

      const session = getSession();
      if (!username || !session) {
        setState({ phase: 'error', message: 'You must be signed in to export.' });
        return;
      }
      const deps: SyncDeps = { username, encryptionKey: session.encryptionKey, api };

      runningRef.current = true;
      setState({ phase: 'running', step: 'sync' });
      void exportAllData({
        format,
        deps,
        excludedListIds,
        onProgress: (progress) => setState({ phase: 'running', ...progress }),
      })
        .then(
          (outcome) => setState({ phase: 'done', outcome }),
          (err: unknown) => {
            if (err instanceof ExportCancelledError) {
              setState({ phase: 'idle' });
              return;
            }
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
    [username, api],
  );

  return { state, run };
}
