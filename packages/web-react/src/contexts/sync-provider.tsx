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

import { useApiClient } from '@stxapps/react';
import { bgStatusForOutcome, type BgSyncStatus, type StoreStatus } from '@stxapps/shared';

import { getSession } from '../data/session-store';
import { isFirstSyncDone } from '../data/sync-store';
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
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const { username, status: authStatus } = useAuth();
  const api = useApiClient();
  const [storeStatus, setStoreStatus] = useState<StoreStatus>('checking');
  const [bgSyncStatus, setBgSyncStatus] = useState<BgSyncStatus>('idle');
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [blockedCount, setBlockedCount] = useState(0);
  // Bumped by retryInitialSync() to re-run the effect.
  const [attempt, setAttempt] = useState(0);
  // Bumped by requestSync() — the local-edit signal the read edge keys on.
  const [localWriteNonce, setLocalWriteNonce] = useState(0);

  // Guards against a stale async resolution writing state after the account
  // changed or the provider unmounted.
  const activeRef = useRef(true);

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

  const retryInitialSync = useCallback(() => {
    setStoreStatus('checking');
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    activeRef.current = true;

    // Only meaningful once auth has settled on a signed-in user; AuthGuard keeps
    // us out of the tree otherwise, but guard anyway.
    if (authStatus !== 'authenticated' || !username) return;

    const session = getSession();
    if (!session) return; // mirror not hydrated yet; the next render will retry

    const deps: SyncDeps = { username, encryptionKey: session.encryptionKey, api };
    // Fresh slate for the indicator — a stale 'error' / stale timestamp from a
    // previous account (or a pre-retry run) must not bleed into this one.
    setBgSyncStatus('idle');
    setLastSyncAt(null);
    setLastError(null);
    setBlockedCount(0);

    // Returning visit → render local data now, refresh in the background. The
    // outcome lands on the INDICATOR (bgSyncStatus), never the gate: a failed
    // background cycle coexists with a usable store, so storeStatus stays put.
    const backgroundSync = () => {
      setBgSyncStatus('syncing');
      void runIncrementalSync(deps).then(
        (outcome) => {
          if (!activeRef.current) return;
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
          if (!activeRef.current) return;
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
          if (!activeRef.current) return;
          setStoreStatus('ready');
          backgroundSync();
          return;
        }
        if (!activeRef.current) return;

        // First sign-in on this device: block on the full pull.
        setStoreStatus('syncing-initial');
        await runInitialSync(deps);
        if (!activeRef.current) return;

        setStoreStatus('ready');
        // Not a second download: a cycle right after the initial pull is usually
        // one empty opsList call (storeDownloads skips current records). It closes
        // the freshness window of the non-snapshot R2 listing and drains any
        // pending ops — the initial sync never pushes — and nothing else would
        // sync until the next local edit. Invariant: reaching 'ready' always
        // kicks a cycle, on both branches.
        backgroundSync();
      } catch (err) {
        if (!activeRef.current) return;
        setStoreStatus('error');
        setLastSyncAt(Date.now());
        setLastError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      activeRef.current = false;
      backgroundSyncRef.current = () => undefined;
    };
  }, [username, authStatus, attempt, api]);

  const value = useMemo<SyncContextValue>(
    () => ({
      storeStatus,
      bgSyncStatus,
      lastSyncAt,
      lastError,
      blockedCount,
      localWriteNonce,
      retryInitialSync,
      requestSync,
    }),
    [
      storeStatus,
      bgSyncStatus,
      lastSyncAt,
      lastError,
      blockedCount,
      localWriteNonce,
      retryInitialSync,
      requestSync,
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
  const requestSyncWithNonce = useCallback(() => {
    setLocalWriteNonce((n) => n + 1);
    requestSync();
  }, [requestSync]);

  const value = useMemo<SyncContextValue>(
    () => ({
      storeStatus,
      bgSyncStatus,
      lastSyncAt,
      lastError,
      blockedCount,
      localWriteNonce,
      retryInitialSync: () => undefined,
      requestSync: requestSyncWithNonce,
    }),
    [
      storeStatus,
      bgSyncStatus,
      lastSyncAt,
      lastError,
      blockedCount,
      localWriteNonce,
      requestSyncWithNonce,
    ],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) throw new Error('useSync must be used within <SyncProvider>');
  return ctx;
}
