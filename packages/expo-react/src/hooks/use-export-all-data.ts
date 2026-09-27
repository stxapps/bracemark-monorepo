// The export-all-data state machine over data/export-all-data.ts — the expo
// sibling of web-react's hooks/use-export-all-data.ts (see there): what the
// Settings → Data → Export view renders. One run at a time. No cancelled
// branch: on this platform the save (the share sheet) happens AFTER the run
// from the outcome's cache file, so there's no mid-run dialog to dismiss.

import { useCallback, useRef, useState } from 'react';

import { useApiClient } from '@stxapps/react';
import type { ExportFormat, ExportProgress } from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { exportAllData, type ExportFileOutcome } from '../data/export-all-data';
import { getSession } from '../data/session-store';
import { beginStallWindow, endStallWindow } from '../lib/stall-probe';
import type { SyncDeps } from '../sync/engine';

export type ExportState =
  | { phase: 'idle' }
  | ({ phase: 'running' } & ExportProgress)
  | { phase: 'done'; outcome: ExportFileOutcome }
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
      // No-ops unless a measurement build started the probe (lib/stall-probe.ts).
      beginStallWindow('export');
      setState({ phase: 'running', step: 'sync' });
      void exportAllData({
        format,
        deps,
        excludedListIds,
        onProgress: (progress) => setState({ phase: 'running', ...progress }),
      })
        .then(
          (outcome) => setState({ phase: 'done', outcome }),
          (err: unknown) =>
            setState({
              phase: 'error',
              message: err instanceof Error ? err.message : String(err),
            }),
        )
        .finally(() => {
          endStallWindow();
          runningRef.current = false;
        });
    },
    [username, api],
  );

  return { state, run };
}
