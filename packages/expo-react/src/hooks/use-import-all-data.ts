// The import-all-data state machine over data/import-all-data.ts — the expo
// sibling of web-react's hooks/use-import-all-data.ts (see there); the mirror
// of use-export-all-data.ts. One run at a time. On success it kicks the
// SyncProvider's requestSync so the freshly-queued pending ops drain through
// the normal engine cycle (and the sync status card shows it), rather than
// running a private sync of its own. The `quota` phase and its parked-promise
// ref work exactly as web's does — see there for why the resolve fn lives in a
// ref rather than in state.

import { useCallback, useRef, useState } from 'react';

import { useApiClient } from '@stxapps/react';
import type {
  ImportOutcome,
  ImportProgress,
  ImportQuotaAnswer,
  ImportQuotaPrompt,
} from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { importAllData, type PickedFile } from '../data/import-all-data';
import { getSession } from '../data/session-store';
import type { SyncDeps } from '../sync/engine';
import { useEntitlements } from './use-entitlements';

export type ImportState =
  | { phase: 'idle' }
  | ({ phase: 'running' } & ImportProgress)
  // Parsed, counted, nothing written: the file holds more new links than the
  // plan has room for. Waiting on answerQuota.
  | { phase: 'quota'; prompt: ImportQuotaPrompt }
  | { phase: 'done'; outcome: ImportOutcome }
  | { phase: 'error'; message: string };

export interface UseImportAllDataResult {
  state: ImportState;
  // Start an import from the picked file; no-op while one is running. Format is
  // detected from the file itself (zip magic → Bracemark backup, else sniffed text).
  run: (file: PickedFile) => void;
  // Answer the `quota` phase. 'import-what-fits' resumes the run with the first
  // `prompt.room` links; 'cancel' fails it with the quota message. A no-op in
  // any other phase.
  answerQuota: (answer: ImportQuotaAnswer) => void;
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
  // The suspended orchestrator's resolve fn while the `quota` phase is on screen.
  const quotaResolveRef = useRef<((answer: ImportQuotaAnswer) => void) | null>(null);

  const answerQuota = useCallback((answer: ImportQuotaAnswer) => {
    const resolve = quotaResolveRef.current;
    if (resolve === null) return;
    quotaResolveRef.current = null;
    // Back to a running spinner on both answers — 'cancel' throws inside the
    // orchestrator, which lands on the error phase a tick later.
    setState({ phase: 'running', step: 'items' });
    resolve(answer);
  }, []);

  const run = useCallback(
    (file: PickedFile) => {
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
        onQuotaPrompt: (prompt) =>
          new Promise((resolve) => {
            quotaResolveRef.current = resolve;
            setState({ phase: 'quota', prompt });
          }),
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
          // A run that ended without the prompt being answered (any other
          // failure while it was on screen) must not leave a live resolve behind.
          quotaResolveRef.current = null;
        });
    },
    [username, api, entitlements.maxLinks, entitlements.nestedLists, requestSync],
  );

  return { state, run, answerQuota };
}
