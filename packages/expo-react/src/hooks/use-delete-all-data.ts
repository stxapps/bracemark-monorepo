// The delete-all-data state machine over data/delete-all-data.ts — the expo
// sibling of web-react's hooks/use-delete-all-data.ts, verbatim (see there):
// one run at a time, idle → running → done/error. No progress steps: the server
// wipe is a single call, so `running` is one spinner, and `done` carries the
// deleted count for the receipt line.

import { useCallback, useRef, useState } from 'react';

import { useApiClient } from '@stxapps/react';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { deleteAllData, type DeleteAllOutcome, type DeleteAllStep } from '../data/delete-all-data';

export type DeleteAllState =
  | { phase: 'idle' }
  | { phase: 'running'; step: DeleteAllStep }
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
  const { requestSync } = useSync();
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
    setState({ phase: 'running', step: 'deleting' });
    void deleteAllData({
      username,
      api,
      onStep: (step) => setState({ phase: 'running', step }),
    })
      .then(
        (outcome) => {
          // Besides starting the now-empty follow-up cycle, requestSync marks
          // this as a local write. The links screen can stay mounted (and
          // scrolled) behind Settings, so its staged-repaint policy must apply
          // this user-requested wipe immediately rather than hide it behind the
          // background-update refresh pill.
          requestSync();
          setState({ phase: 'done', outcome });
        },
        (err: unknown) =>
          setState({
            phase: 'error',
            message: err instanceof Error ? err.message : String(err),
          }),
      )
      .finally(() => {
        runningRef.current = false;
      });
  }, [username, api, requestSync]);

  return { state, run };
}
