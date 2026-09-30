'use client';

// The import-all-data state machine over data/import-all-data.ts — what the
// Settings → Data → Import view renders; the mirror of use-export-all-data.ts.
// One run at a time per app — module state, so it survives the view (the run
// section below). On success it kicks the SyncProvider's requestSync so the
// freshly-queued pending ops drain through the normal engine cycle (and the sync
// status card shows it), rather than running a private sync of its own.
//
// The one non-linear bit is the `quota` phase: an interop file that would pass
// the plan's link cap suspends the run and hands the counts to the view, which
// answers with `answerQuota`. The orchestrator is literally awaiting that answer
// (data/import-all-data.ts → shared resolveImportQuota), so the promise it
// blocks on is parked beside the run rather than in its rendered state — nothing
// re-renders on it, and resolving it twice is impossible because it is cleared
// as it fires.

import { useCallback, useEffect, useSyncExternalStore } from 'react';

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

// --- the run, per app rather than per view ------------------------------------
//
// A run outlives the view that started it: leaving Settings → Data unmounts this
// hook, but the orchestrator keeps writing. When the run lived in hook state, a
// view mounted meanwhile read `idle` and offered the picker again, and a second
// interop run deduped against a library the first had not finished writing, so
// every link the first was still to write landed twice. The run is module state
// instead: a view mounted mid-run shows its progress and then its receipt, and
// `run` refuses a second one while the first is in flight.
//
// The rendered half is an immutable snapshot for useSyncExternalStore; the rest
// is never rendered and lives beside it.
interface RunSnapshot {
  id: number;
  username: string | null;
  state: ImportState;
}

const IDLE: ImportState = { phase: 'idle' };
let snapshot: RunSnapshot | null = null;
let nextRunId = 1;
// Still inside the orchestrator. The re-entrancy guard, and not tied to a view.
let inFlight = false;
// The suspended orchestrator's resolve fn while the `quota` phase is on screen.
let resolveQuota: ((answer: ImportQuotaAnswer) => void) | null = null;
// The run's quota prompt was answered 'cancel'. `resolveImportQuota` carries that
// out by throwing ImportQuotaError — the very error the gate throws when it
// refuses on its own — so the rejection handler needs this to tell the two apart.
let cancelled = false;
// Mounted views. The last one to unmount is what "the user left" means.
let views = 0;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): RunSnapshot | null {
  return snapshot;
}

// Publish a run's next state, unless a newer run (or the unmount below) has
// already replaced it.
function publish(id: number, state: ImportState): void {
  if (snapshot?.id !== id) return;
  snapshot = { ...snapshot, state };
  for (const listener of listeners) listener();
}

// Settle an unanswered quota prompt as a cancel: nothing has been written, and
// the answer resumes the orchestrator so it can close its archive and return.
function cancelQuota(): void {
  const resolve = resolveQuota;
  if (resolve === null) return;
  resolveQuota = null;
  cancelled = true;
  if (snapshot !== null) publish(snapshot.id, IDLE);
  resolve('cancel');
}

export function useImportAllData(): UseImportAllDataResult {
  const { username } = useAuth();
  const { requestSync } = useSync();
  const api = useApiClient();
  // The plan gates the orchestrator enforces: the upfront link cap and whether
  // folder paths may create nested lists.
  const { entitlements } = useEntitlements();
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // A run belongs to the account that started it.
  const state = current !== null && current.username === username ? current.state : IDLE;

  useEffect(() => {
    views += 1;
    return () => {
      views -= 1;
      // Decided a microtask later, not here. StrictMode's mount → cleanup → mount
      // runs this cleanup and re-mounts in the same synchronous commit; taken at face
      // value, that reads as the user leaving and drops the receipt the re-mount was
      // about to show. A real departure is still at zero by then.
      queueMicrotask(() => {
        if (views > 0) return;
        // A quota decision has no owner once the last view unmounts.
        cancelQuota();
        // A settled run's receipt was for the view that watched it; the next view
        // starts idle. A run still writing stays, so the next view shows it.
        if (!inFlight) snapshot = null;
      });
    };
  }, []);

  const answerQuota = useCallback((answer: ImportQuotaAnswer) => {
    // 'cancel' ends the run as a NON-EVENT: nothing has been written, and the user
    // chose this a keystroke ago. So the view drops straight back to idle rather
    // than flashing a spinner on its way to an error phase that would restate the
    // counts as a refusal and ANNOUNCE (role="alert") a failure the user asked
    // for. The choice card unmounting is the feedback; a receipt for a non-event
    // is clutter, the same reason idle renders nothing at all. Only the cancel
    // path is quiet — the gate's own refusals (no room, a backup file) still land
    // on the error phase. docs/data-lifecycle.md — _the import's quota gate_.
    if (answer === 'cancel') {
      cancelQuota();
      return;
    }
    // 'import-what-fits' resumes the run, so it goes back to a spinner.
    const resolve = resolveQuota;
    if (resolve === null || snapshot === null) return;
    resolveQuota = null;
    publish(snapshot.id, { phase: 'running', step: 'items' });
    resolve(answer);
  }, []);

  const run = useCallback(
    (file: File) => {
      if (inFlight) return;

      const session = getSession();
      if (!username || !session) {
        snapshot = {
          id: nextRunId++,
          username,
          state: { phase: 'error', message: 'You must be signed in to import.' },
        };
        for (const listener of listeners) listener();
        return;
      }
      const deps: SyncDeps = { username, encryptionKey: session.encryptionKey, api };

      const id = nextRunId++;
      inFlight = true;
      cancelled = false;
      snapshot = { id, username, state: { phase: 'running', step: 'sync' } };
      for (const listener of listeners) listener();
      void importAllData({
        file,
        deps,
        maxLinks: entitlements.maxLinks,
        onProgress: (progress) => publish(id, { phase: 'running', ...progress }),
        onQuotaPrompt: (prompt) =>
          new Promise((resolve) => {
            resolveQuota = resolve;
            // Parsing can finish after the last view has gone, when there was no
            // prompt yet for its unmount to cancel.
            if (views === 0) cancelQuota();
            else publish(id, { phase: 'quota', prompt });
          }),
      })
        .then(
          (outcome) => {
            publish(id, { phase: 'done', outcome });
            // Drain the queued ops through the normal cycle (coalesces with any
            // in-flight one) — the imported data starts syncing right away.
            requestSync();
          },
          (err: unknown) => {
            // A cancelled run is already back on idle — its ImportQuotaError is
            // the answer being carried out, not a failure to report.
            if (cancelled) return;
            publish(id, {
              phase: 'error',
              message: err instanceof Error ? err.message : String(err),
            });
          },
        )
        .finally(() => {
          inFlight = false;
          // A run that ended without the prompt being answered (any other
          // failure while it was on screen) must not leave a live resolve behind.
          resolveQuota = null;
        });
    },
    [username, api, entitlements.maxLinks, requestSync],
  );

  return { state, run, answerQuota };
}
