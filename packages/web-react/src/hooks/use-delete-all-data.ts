'use client';

// The delete-all-data state machine over data/delete-all-data.ts — what the
// Settings → Data → Delete view renders. Mirrors useExportAllData/
// useImportAllData: one run at a time, idle → running → done/error. No progress steps: the server wipe is a
// single call (the whole point of doing it server-side), so `running` is one
// spinner, and `done` carries the deleted count for the receipt line.

import { useCallback, useRef, useState } from 'react';

import { useApiClient } from '@stxapps/react';

import { useAuth } from '../contexts/auth-provider';
import { deleteAllData, type DeleteAllOutcome } from '../data/delete-all-data';

export type DeleteAllState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; outcome: DeleteAllOutcome }
  | { phase: 'error'; message: string };

export interface UseDeleteAllDataResult {
  state: DeleteAllState;
  // Start the wipe; no-op while one is running. The endpoint is idempotent, so
  // retrying after an error is just calling this again.
  run: () => void;
}

export function useDeleteAllData(): UseDeleteAllDataResult {
  const { username } = useAuth();
  const api = useApiClient();
  const [state, setState] = useState<DeleteAllState>({ phase: 'idle' });
  // Re-entrancy guard that doesn't wait for the state update to land.
  const runningRef = useRef(false);

  const run = useCallback(() => {
    if (runningRef.current) return;

    if (!username) {
      setState({ phase: 'error', message: 'You must be signed in to delete your data.' });
      return;
    }

    runningRef.current = true;
    setState({ phase: 'running' });
    void deleteAllData({ username, api })
      .then(
        (outcome) => setState({ phase: 'done', outcome }),
        (err: unknown) =>
          setState({
            phase: 'error',
            message: err instanceof Error ? err.message : String(err),
          }),
      )
      .finally(() => {
        runningRef.current = false;
      });
  }, [username, api]);

  return { state, run };
}
