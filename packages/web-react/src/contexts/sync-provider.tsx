'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { SESSION_COPY, useApiClient } from '@stxapps/react';
import {
  bgStatusForOutcome,
  type BgSyncStatus,
  type InitialSyncProgress,
  type InitialSyncProgressFn,
  type StoreStatus,
} from '@stxapps/shared';

import { getSession } from '../data/session-store';
import { isFirstSyncDone } from '../data/sync-store';
import { isUpdateRequired, onUpdateRequired } from '../data/update-required';
import { runIncrementalSync, runInitialSync, type SyncDeps } from '../sync/engine';
import { useAuth } from './auth-provider';

// Sync state for the signed-in app — deliberately SEPARATE from auth state (see
// auth-provider). Auth answers "do you have a session?" and drives redirects;
// sync answers "is the local store ready?" and drives an in-route loading screen
// (InitialSyncGate), never a redirect. Folding this into AuthStatus/EndReason would
// muddy a type that's specifically about why you became unauthenticated.
//
// The branch is decided by the persisted first-sync flag (sync-store), not by
// remembering whether the user just created vs. signed in:
//   firstSyncDone  → 'ready' immediately, incremental sync runs in background
//   not done       → 'syncing-initial' (blocking full pull), then 'ready'
// Account creation seeds the flag at signup, so it lands in the first branch
// with no network round-trip.
//
// Sync state itself is TWO dimensions, kept as two fields rather than one enum:
//   storeStatus  — the gate: can the app render local data at all? Durable; once
//                  'ready' it stays 'ready' while cycles come and go.
//   bgSyncStatus — the indicator: health of the current/last background cycle. A
//                  failed background cycle coexists with a usable store (that's
//                  the point of local-first), so it must not leave 'ready'.

// StoreStatus (the gate) and BgSyncStatus (the indicator) are the shared,
// platform-free sync vocabulary — defined in @stxapps/shared so a native client
// speaks the same language — and imported above. SyncProvider is one concrete
// producer of them.
// How often the first-sync counter is allowed to re-render the gate. The engine
// reports once per decrypted record and runs 24 downloads at a time, so an
// unthrottled feed is hundreds of setStates a second — competing with WebCrypto
// for the same main thread, to move a number faster than anyone can read it.
// ~10 renders a second looks continuous and costs nothing.
//
// The coalescing lives HERE rather than in the engine deliberately: the engine is
// React-free (it also runs in the extension's service worker, which has no
// renders to schedule), so a rendering cadence is not its policy to hold.
const PROGRESS_FLUSH_MS = 100;

interface SyncContextValue {
  storeStatus: StoreStatus;
  bgSyncStatus: BgSyncStatus;
  // The last (or in-flight) cycle's completion, kept alongside bgSyncStatus so a
  // status page can render "last synced …" / the failure reason without threading a
  // second source through. `lastSyncAt` is the epoch ms the last cycle finished —
  // success OR failure; null before any cycle has finished. `lastError` is that
  // cycle's error message, or null when it succeeded.
  lastSyncAt: number | null;
  lastError: string | null;
  // How many pending ops the plan/quota gate refused on the last cycle — the
  // detail line for a `blocked-*` status, exactly as `lastError` is the detail
  // for 'error'. 0 whenever nothing was refused.
  blockedCount: number;
  // Determinate progress for the BLOCKING first pull, throttled to
  // PROGRESS_FLUSH_MS — the gate's counter, and the only reason a first sync of a
  // large library doesn't look like a hang. Null means "no number yet": before the
  // pull starts, while it is still listing the manifest (the denominator doesn't
  // exist until that returns), and on every returning visit, where no initial sync
  // runs at all. It deliberately survives the switch to 'ready' so the gate's
  // minimum-visible floor shows a FULL bar for its last moments instead of
  // dropping back to a bare spinner; it's cleared when a run fails, and reset with
  // the rest of the state on retry.
  initialSyncProgress: InitialSyncProgress | null;
  // Bumped each time requestSync() runs — i.e. on every local edit on THIS
  // device (pin/unpin/move today; any mutation kicks a cycle the same way). The
  // read edge (useLinks) keys on it to apply the user's own change immediately
  // instead of staging it behind the refresh pill: an edit you just made must
  // never hide behind "new updates".
  localWriteNonce: number;
  // Re-attempt a failed initial sync (the gate's retry).
  retryInitialSync: () => void;
  // Kick a background incremental cycle now — e.g. right after a local edit
  // enqueues a pending op. Doubles as the retry when a background cycle fails
  // (bgSyncStatus 'error'): retrying a failed cycle and running a fresh one are the
  // same operation, so there's no separate retryBgSync. Safe to call eagerly:
  // the engine single-flights per account (overlapping calls coalesce into one
  // trailing rerun). No-op until a session is usable.
  requestSync: () => void;
  // The same cycle, asked for by the USER rather than by a write: the ⋯ menu's
  // Sync and the Data card's Sync now / Retry. It does NOT bump
  // `localWriteNonce`, because it is not a local edit — what it brings in is
  // another device's writes, which the read edge must stage behind the refresh
  // pill while the list is engaged, exactly as it would any other pull. Routed
  // through requestSync, a press while scrolled promoted the pull inside the
  // grace window and shifted every row under the reader
  // (e2e SYNC-REFRESH-PILL-*, docs/client-queries.md).
  syncNow: () => void;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const { username, status: authStatus, sessionState } = useAuth();
  const api = useApiClient();
  const [storeStatus, setStoreStatus] = useState<StoreStatus>('checking');
  const [bgSyncStatus, setBgSyncStatus] = useState<BgSyncStatus>('idle');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [blockedCount, setBlockedCount] = useState(0);
  const [initialSyncProgress, setInitialSyncProgress] = useState<InitialSyncProgress | null>(null);
  // Bumped by retryInitialSync() to re-run the effect.
  const [attempt, setAttempt] = useState(0);
  // Bumped by requestSync() — the local-edit signal the read edge keys on.
  const [localWriteNonce, setLocalWriteNonce] = useState(0);
  // A newer build took over this origin's databases (update-required.ts): this
  // tab can no longer read or write them, so it must stop scheduling cycles.
  const [halted, setHalted] = useState(isUpdateRequired);
  useEffect(() => onUpdateRequired(() => setHalted(true)), []);

  // Latest background-sync runner; requestSync goes through this ref so its
  // identity stays stable while the account/session underneath changes. Reset to
  // a no-op on cleanup so a late caller can't sync a signed-out account.
  const backgroundSyncRef = useRef<() => void>(() => undefined);
  const requestSync = useCallback(() => {
    // Mark a local edit before kicking the cycle, so the read edge applies this
    // device's own change without waiting on (or staging behind) the sync.
    setLocalWriteNonce((n) => n + 1);
    backgroundSyncRef.current();
  }, []);
  const syncNow = useCallback(() => backgroundSyncRef.current(), []);

  const retryInitialSync = useCallback(() => {
    setStoreStatus('checking');
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    // Each effect owns its cancellation flag. A replacement must never revive
    // an older cycle by setting a shared ref back to true.
    let active = true;

    // Only meaningful once auth has settled on a signed-in user; AuthGuard keeps
    // us out of the tree otherwise, but guard anyway.
    if (authStatus !== 'authenticated' || !username) return;
    // The database belongs to a newer build now; nothing here may touch it.
    if (halted) return;

    const session = getSession();
    if (!session) return; // mirror not hydrated yet; the next render will retry

    // EXPIRED (docs/sessions.md): the server wants a sign-in before it syncs
    // again, so schedule nothing — a cycle would only earn the same answer. The
    // store stays exactly as usable as offline; edits keep queueing as pending
    // ops and push on resume. The one thing a pause can't give is a first sync
    // that never finished: that store isn't complete, so the gate says why.
    if (sessionState === 'expired') {
      backgroundSyncRef.current = () => undefined;
      setBgSyncStatus('paused');
      setBlockedCount(0);
      setInitialSyncProgress(null);
      void isFirstSyncDone(username).then(
        (done) => {
          if (!active) return;
          if (done) {
            setStoreStatus('ready');
            setLastError(null);
          } else {
            setStoreStatus('error');
            setLastError(SESSION_COPY.paused.beforeFirstSync);
          }
        },
        () => undefined,
      );
      return () => {
        active = false;
      };
    }

    const deps: SyncDeps = { username, encryptionKey: session.encryptionKey, api };
    // Fresh slate for the indicator — a stale 'error' / stale timestamp from a
    // previous account (or a pre-retry run) must not bleed into this one.
    setBgSyncStatus('idle');
    setLastSyncAt(null);
    setLastError(null);
    setBlockedCount(0);
    setInitialSyncProgress(null);

    // Trailing-edge coalescer for the first-sync counter (see PROGRESS_FLUSH_MS):
    // every tick overwrites the pending value, and at most one flush is scheduled
    // at a time, so a burst of records costs one render. Effect-scoped locals
    // rather than refs — the scope is exactly right, since a new account (or a
    // retry) re-runs the effect and must not inherit the previous run's count.
    let progressTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingProgress: InitialSyncProgress | null = null;
    const flushProgress = () => {
      progressTimer = null;
      if (!active || !pendingProgress) return;
      setInitialSyncProgress(pendingProgress);
      pendingProgress = null;
    };
    const reportProgress: InitialSyncProgressFn = (done, total) => {
      pendingProgress = { done, total };
      progressTimer ??= setTimeout(flushProgress, PROGRESS_FLUSH_MS);
    };
    // Settle at the end of a run. On success the final count is pushed through
    // immediately instead of waiting out the last coalescing window, so the bar the
    // gate holds up during its minimum-visible floor is a full one rather than the
    // second-to-last tick. On failure it's dropped: the error screen carries no bar.
    const settleProgress = (keep: boolean) => {
      if (progressTimer !== null) clearTimeout(progressTimer);
      progressTimer = null;
      if (keep && pendingProgress) setInitialSyncProgress(pendingProgress);
      if (!keep) setInitialSyncProgress(null);
      pendingProgress = null;
    };

    // Returning visit → render local data now, refresh in the background. The
    // outcome lands on the INDICATOR (bgSyncStatus), never the gate: a failed
    // background cycle coexists with a usable store, so storeStatus stays put.
    const backgroundSync = () => {
      setBgSyncStatus('syncing');
      void runIncrementalSync(deps).then(
        (outcome) => {
          if (!active) return;
          // A completed cycle is 'idle' UNLESS the plan/quota gate refused part
          // of the push — that resolves rather than rejects (the rest of the
          // cycle succeeded), so it would otherwise read as a clean sync while
          // the user's links sit unpushed. The `blocked-*` statuses are settled
          // states, not failures: they clear on the next cycle once the account
          // is upgraded or back under its limits. Which one (and the count) is
          // the engine's answer, mapped in shared so both platforms agree.
          setBgSyncStatus(bgStatusForOutcome(outcome));
          setBlockedCount(outcome.blockedCount);
          setLastSyncAt(Date.now());
          setLastError(null);
        },
        (err: unknown) => {
          if (!active) return;
          setBgSyncStatus('error');
          setBlockedCount(0);
          setLastSyncAt(Date.now());
          setLastError(err instanceof Error ? err.message : String(err));
        },
      );
    };
    backgroundSyncRef.current = backgroundSync;

    void (async () => {
      try {
        if (await isFirstSyncDone(username)) {
          if (!active) return;
          setStoreStatus('ready');
          backgroundSync();
          return;
        }
        if (!active) return;

        // First sign-in on this device: block on the full pull.
        setStoreStatus('syncing-initial');
        await runInitialSync(deps, reportProgress);
        if (!active) return;

        settleProgress(true);
        setStoreStatus('ready');
        // Not a second download: a cycle right after the initial pull is usually
        // one empty opsList call (storeDownloads skips current records). It closes
        // the freshness window of the non-snapshot R2 listing and drains any
        // pending ops — the initial sync never pushes — and nothing else would
        // sync until the next local edit. Invariant: reaching 'ready' always
        // kicks a cycle, on both branches.
        backgroundSync();
      } catch (err) {
        if (!active) return;
        settleProgress(false);
        setStoreStatus('error');
        setLastSyncAt(Date.now());
        setLastError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      active = false;
      backgroundSyncRef.current = () => undefined;
      if (progressTimer !== null) clearTimeout(progressTimer);
    };
  }, [username, authStatus, sessionState, halted, attempt, api]);

  const value = useMemo<SyncContextValue>(
    () => ({
      storeStatus,
      bgSyncStatus,
      lastSyncAt,
      lastError,
      blockedCount,
      initialSyncProgress,
      localWriteNonce,
      retryInitialSync,
      requestSync,
      syncNow,
    }),
    [
      storeStatus,
      bgSyncStatus,
      lastSyncAt,
      lastError,
      blockedCount,
      initialSyncProgress,
      localWriteNonce,
      retryInitialSync,
      requestSync,
      syncNow,
    ],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

// A SyncContext provider for clients whose sync ENGINE runs in a SEPARATE JS context
// — e.g. a service worker, another tab, or a web worker — rather than in the page that
// mounts this provider. It satisfies the same `useSync` contract the editor hooks
// depend on (useLinkMutations / useTagMutations / … all call `requestSync` after a
// write), but instead of driving runIncrementalSync itself it DELEGATES `requestSync`
// to the caller — which signals that other context to run a cycle. Store/bg status
// (and the last-cycle timestamp/error) are passed in (the caller sources them from
// wherever that context reports them, e.g. `browser.storage`), defaulting to a ready,
// idle store so the editor is usable as soon as the page mounts. `localWriteNonce`
// still bumps on each requestSync so any read edge keyed on it stays correct.
export function ExternalSyncProvider({
  children,
  storeStatus = 'ready',
  bgSyncStatus = 'idle',
  lastSyncAt = null,
  lastError = null,
  blockedCount = 0,
  requestSync,
}: {
  children: ReactNode;
  storeStatus?: StoreStatus;
  bgSyncStatus?: BgSyncStatus;
  lastSyncAt?: number | null;
  lastError?: string | null;
  blockedCount?: number;
  requestSync: () => void;
}) {
  const [localWriteNonce, setLocalWriteNonce] = useState(0);
  // The session state is this context's own to read (it runs the AuthProvider),
  // and fresher than the mirror: an expiry recorded here shows as 'paused' at
  // once, rather than after the engine's context next writes its status.
  const { sessionState } = useAuth();
  const effectiveBgSyncStatus: BgSyncStatus = sessionState === 'expired' ? 'paused' : bgSyncStatus;
  const requestSyncWithNonce = useCallback(() => {
    setLocalWriteNonce((n) => n + 1);
    requestSync();
  }, [requestSync]);

  const value = useMemo<SyncContextValue>(
    () => ({
      storeStatus,
      bgSyncStatus: effectiveBgSyncStatus,
      lastSyncAt,
      lastError,
      blockedCount,
      // Not a prop, and deliberately always null: the first-sync counter is a
      // per-record feed, and the mirror these clients read is a `browser.storage`
      // write per state change — pushing ~10 writes a second through it to animate
      // a bar would cost more than the bar is worth. The only surface that wants
      // the number is the blocking decrypting screen, and no external-engine client
      // renders one (the extension popup shows the phase as a pill). A consumer
      // reads null exactly as it reads the listing phase: indeterminate.
      initialSyncProgress: null,
      localWriteNonce,
      retryInitialSync: () => undefined,
      requestSync: requestSyncWithNonce,
      // The caller's own signal, unmarked — a user-asked cycle is not a write.
      syncNow: requestSync,
    }),
    [
      storeStatus,
      effectiveBgSyncStatus,
      lastSyncAt,
      lastError,
      blockedCount,
      localWriteNonce,
      requestSyncWithNonce,
      requestSync,
    ],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within <SyncProvider>');
  return ctx;
}
