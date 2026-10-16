'use client';

// The delete-all-data state machine over data/delete-all-data.ts — what the
// Settings → Data → Delete view renders. Mirrors useExportAllData/
// useImportAllData: one run at a time, idle → running → done / error /
// account-changed. No progress steps: the server wipe is a single call (the
// whole point of doing it server-side), so `running` is one spinner, and `done`
// carries the deleted count for the receipt line.

import { useCallback, useRef, useState } from 'react';

import { useApiClient } from '@stxapps/react';
import { DeleteAllAccountChangedError, DeleteAllUncertainError } from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { deleteAllData, type DeleteAllOutcome, type DeleteAllStep } from '../data/delete-all-data';

export type DeleteAllState =
  | { phase: 'idle' }
  | { phase: 'running'; step: DeleteAllStep }
  | { phase: 'done'; outcome: DeleteAllOutcome }
  // `unsyncedDiscarded` — the call failed without saying whether the wipe ran
  // (shared's DeleteAllUncertainError), so this device's unsynced changes were
  // dropped rather than left to push into a namespace that may be empty, and the
  // failure line cannot say nothing was removed.
  | { phase: 'error'; message: string; unsyncedDiscarded?: boolean }
  // The account changed under the view. TERMINAL like `done`, and unlike `error`
  // not something to try again: a retry would be the new account's wipe on the
  // previous account's confirmation. `serverWiped` — whether the account that
  // asked was deleted on the server before the run stopped
  // (shared's DeleteAllAccountChangedError).
  | { phase: 'account-changed'; serverWiped: boolean };

export interface UseDeleteAllDataResult {
  state: DeleteAllState;
  // Start the wipe; no-op while one is running. The endpoint is idempotent, so
  // retrying after an error is just calling this again — for the account the view
  // was opened for. Once that changes, `run` only reports `account-changed`.
  run: () => void;
}

export function useDeleteAllData(): UseDeleteAllDataResult {
  const { username } = useAuth();
  const api = useApiClient();
  const [state, setState] = useState<DeleteAllState>({ phase: 'idle' });
  // Re-entrancy guard that doesn't wait for the state update to land.
  const runningRef = useRef(false);
  // The account this view was OPENED for, and the only one it will delete for.
  // What the view collects — its tick, an error's "try again" — was given for
  // the account on screen, and `username` can change under a mounted view: another
  // tab signs in as someone else and this one adopts the session in place. A run
  // after that would wipe the new account on the old account's say-so, so it is
  // refused below and the view has to be opened again. Captured at mount, not at
  // the first run: by then the tick may already be the previous account's.
  //
  // A guard on the VIEW, not the bind — that is the server's check on the name
  // (data/delete-all-data.ts). This one compares names, so it passes again after
  // A → B → A, and it reads React state, which trails the session a request is
  // signed with.
  const [openedFor] = useState(username);

  const run = useCallback(() => {
    if (runningRef.current) return;

    if (!username) {
      setState({ phase: 'error', message: 'You must be signed in to delete your data.' });
      return;
    }

    if (username !== openedFor) {
      setState({ phase: 'account-changed', serverWiped: false });
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
        (outcome) => setState({ phase: 'done', outcome }),
        (err: unknown) =>
          setState(
            err instanceof DeleteAllAccountChangedError
              ? { phase: 'account-changed', serverWiped: err.serverWiped }
              : {
                  phase: 'error',
                  message: err instanceof Error ? err.message : String(err),
                  unsyncedDiscarded: err instanceof DeleteAllUncertainError,
                },
          ),
      )
      .finally(() => {
        runningRef.current = false;
      });
  }, [username, openedFor, api]);

  return { state, run };
}
