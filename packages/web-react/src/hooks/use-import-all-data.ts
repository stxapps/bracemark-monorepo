'use client';

// The import-all-data state machine over data/import-all-data.ts — what the
// Settings → Data → Import view renders; the mirror of use-export-all-data.ts.
// One run at a time. On success it kicks the SyncProvider's requestSync so the
// freshly-queued pending ops drain through the normal engine cycle (and the sync
// status card shows it), rather than running a private sync of its own.
//
// The one non-linear bit is the `quota` phase: an interop file that would pass
// the plan's link cap suspends the run and hands the counts to the view, which
// answers with `answerQuota`. The orchestrator is literally awaiting that answer
// (data/import-all-data.ts → shared resolveImportQuota), so the promise it
// blocks on is parked in a ref here rather than in React state — nothing
// re-renders on it, and resolving it twice is impossible because the ref is
// cleared as it fires.

import { useCallback, useEffect, useRef, useState } from 'react';

import { useApiClient } from '@stxapps/react';
import type {
  ImportOutcome,
  ImportProgress,
  ImportQuotaAnswer,
  ImportQuotaPrompt,
} from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { importAllData } from '../data/import-all-data';
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
  run: (file: File) => void;
  // Answer the `quota` phase. 'import-what-fits' resumes the run with the first
  // `prompt.room` links; 'cancel' abandons it and drops back to idle. A no-op in
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
  // The user answered 'cancel'. `resolveImportQuota` carries that out by throwing
  // ImportQuotaError — the very error the gate throws when it refuses on its own
  // — so the rejection handler below needs this to tell the two apart.
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // A quota decision has no owner once Settings unmounts. Settle it so the
      // orchestrator can close its archive and release any live-read hold.
      const resolve = quotaResolveRef.current;
      quotaResolveRef.current = null;
      resolve?.('cancel');
    };
  }, []);

  const answerQuota = useCallback((answer: ImportQuotaAnswer) => {
    const resolve = quotaResolveRef.current;
    if (resolve === null) return;
    quotaResolveRef.current = null;
    // 'import-what-fits' resumes the run, so it goes back to a spinner. 'cancel'
    // ends it, and ends it as a NON-EVENT: nothing has been written, and the user
    // chose this a keystroke ago. So the view drops straight back to idle rather
    // than flashing a spinner on its way to an error phase that would restate the
    // counts as a refusal and ANNOUNCE (role="alert") a failure the user asked
    // for. The choice card unmounting is the feedback; a receipt for a non-event
    // is clutter, the same reason idle renders nothing at all. Only the cancel
    // path is quiet — the gate's own refusals (no room, a backup file) still land
    // on the error phase. docs/data-lifecycle.md — _the import's quota gate_.
    cancelledRef.current = answer === 'cancel';
    setState(answer === 'cancel' ? { phase: 'idle' } : { phase: 'running', step: 'items' });
    resolve(answer);
  }, []);

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
      cancelledRef.current = false;
      setState({ phase: 'running', step: 'sync' });
      void importAllData({
        file,
        deps,
        maxLinks: entitlements.maxLinks,
        onProgress: (progress) => {
          if (mountedRef.current) setState({ phase: 'running', ...progress });
        },
        onQuotaPrompt: (prompt) =>
          new Promise((resolve) => {
            // Parsing can finish after navigation away, before there was a
            // resolver for the cleanup above to cancel.
            if (!mountedRef.current) {
              resolve('cancel');
              return;
            }
            quotaResolveRef.current = resolve;
            setState({ phase: 'quota', prompt });
          }),
      })
        .then(
          (outcome) => {
            if (mountedRef.current) setState({ phase: 'done', outcome });
            // Drain the queued ops through the normal cycle (coalesces with any
            // in-flight one) — the imported data starts syncing right away.
            requestSync();
          },
          (err: unknown) => {
            // A cancelled run is already back on idle — its ImportQuotaError is
            // the answer being carried out, not a failure to report.
            if (cancelledRef.current || !mountedRef.current) return;
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
    [username, api, entitlements.maxLinks, requestSync],
  );

  return { state, run, answerQuota };
}
