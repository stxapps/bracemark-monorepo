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
import { useQueryClient } from '@tanstack/react-query';

import { useApiClient } from '@stxapps/react';
import { newSessionGeneration, sessionProbeEndpoint, type SessionState } from '@stxapps/shared';

import { clearData } from '../data/clear-data';
import {
  activeRecord,
  clearSession,
  loadSession,
  onSessionChange,
  onSessionVerdict,
  peekSession,
  publishSessionChange,
  saveSession,
  type SessionChangeMessage,
  type SessionCredentials,
  type SessionRecord,
  type SessionVerdictEvent,
  withSessionLock,
} from '../data/session-store';
import { beginInitialSync, seedNewAccount } from '../data/sync-store';

// App-level auth state, and THE LIFECYCLE OWNER (docs/sessions.md, _who acts on a
// 401_): the only code in a web context that writes session state or wipes a
// device. It runs in the web app and in the browser extension's popup and options
// page; the extension's background worker carries the token but never acts on it.
// Only `username`/`status`/`sessionState` enter React state — the bearer token and
// the non-extractable encryptionKey stay in the session store (read where needed
// via getToken/getSession), keeping key material out of the component tree.
//
// ⚠ WHAT MAY WIPE THIS DEVICE. Exactly two things: an explicit sign-out here
// (endSession), or a `session_revoked` verdict from bracemark-api for the session
// generation still persisted here. Expiry and an unknown token KEEP everything and
// enter the expired state. No clock, no other status, no codeless or foreign 401
// — and no failed storage read — may reach a wipe. Nothing fails if this is broken
// except a user's only copy, the day the server is gone.

// 'ending' is the TEARDOWN frame: a wipe has started but hasn't finished. It exists
// so the gates can close the app subtree BEFORE the local store empties — see
// teardown for the race that costs. Treat it exactly like 'loading' at every gate
// (render nothing, decide nothing); it is deliberately NOT 'unauthenticated',
// because that is the state that triggers the exit navigation, and that must wait
// until the wipe has actually run.
type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'ending';
// Why we left 'authenticated'. Lets AuthGuard pick the right destination: a
// deliberate 'signed-out' leaves the app for the marketing site's landing page,
// while 'revoked' (the server told this device to forget — sign out other
// devices, or the account was deleted elsewhere) or a direct visit (reason null)
// goes to /sign-in, which says why. An EXPIRED session never leaves the app at
// all: it stays 'authenticated' with sessionState 'expired'.
type EndReason = 'signed-out' | 'revoked';

interface AuthContextValue {
  status: AuthStatus;
  isAuthenticated: boolean;
  username: string | null;
  // 'active' or 'expired' while authenticated, null otherwise. Expired: the
  // library is fully usable, sync is paused, and "Sign in to resume" is on screen.
  sessionState: SessionState | null;
  // Set when status is 'unauthenticated'; null on a direct visit that never had a
  // session this load.
  reason: EndReason | null;
  // Adopt credentials from sign-in / create-account — or RESUME: signing in again
  // with the stored username replaces the token, mints a new generation, sets the
  // session active and KEEPS the local store (with its queued edits) untouched.
  setSession: (
    credentials: SessionCredentials,
    options?: { newAccount?: boolean },
  ) => Promise<void>;
  // The full local teardown — the sign-out PRIMITIVE. Server-side revocation lives
  // in the user-driven useSignOut hook (which POSTs sign-out, then calls this).
  // Defaults to a deliberate 'signed-out' (→ the marketing site's landing page).
  endSession: (reason?: EndReason) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // 'loading' until hydration resolves, so the UI can hold off on auth-gated
  // decisions instead of flashing a signed-out state. Matches on server + first
  // client render (both 'loading'), so there's no hydration mismatch.
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [username, setUsername] = useState<string | null>(null);
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [reason, setReason] = useState<EndReason | null>(null);
  const [generation, setGeneration] = useState<string | null>(null);
  // For the teardown below: the react-query cache is the one per-account store
  // clearData can't reach (it's in-memory React state, not a device store).
  const queryClient = useQueryClient();
  // For the expired state's probe.
  const api = useApiClient();

  // The latest committed values, for the async handlers below — which run
  // outside render, often after this context's state moved on.
  const statusRef = useRef(status);
  statusRef.current = status;
  const usernameRef = useRef(username);
  usernameRef.current = username;

  // Show a persisted record (or its absence) in React state. `left` explains an
  // absence another context caused.
  const adopt = useCallback(
    (record: SessionRecord | null, left?: EndReason) => {
      if (!record) {
        if (statusRef.current === 'authenticated' || statusRef.current === 'ending') {
          // Torn down elsewhere — that context already wiped. Close this one's UI.
          queryClient.clear();
          setGeneration(null);
          setUsername(null);
          setSessionState(null);
          setReason(left ?? 'signed-out');
          setStatus('unauthenticated');
        }
        return;
      }
      // A different account now owns this device's store (another context signed
      // out and in): nothing this context cached belongs to it.
      if (usernameRef.current !== null && usernameRef.current !== record.username) {
        queryClient.clear();
      }
      setGeneration(record.generation);
      setUsername(record.username);
      setSessionState(record.state);
      setReason(null);
      setStatus('authenticated');
    },
    [queryClient],
  );

  // Hydrate from IndexedDB once on mount, under the lifecycle lock. No clock is
  // consulted: a record is signed in, in whatever state it was persisted with,
  // however old it is.
  useEffect(() => {
    let active = true;
    withSessionLock(async () => {
      let record = await loadSession();
      // A record from before the session redesign has no generation (and a stale
      // `expiresAt`, dropped unread). It is an ACTIVE session, not a corrupt one:
      // assign its generation here, under the lock, so every context agrees on it.
      if (record && !record.generation) {
        record = { ...record, generation: newSessionGeneration() };
        await saveSession(record);
      }
      // No session: finish any interrupted teardown. The local store holds
      // DECRYPTED bookmarks (and lock verifiers), so residue must go before the
      // next account signs in here — the teardown is several independent clears,
      // and a tab closed mid-wipe can leave plaintext with no session row. This
      // branch is decided by the read just made UNDER THE LOCK, so a concurrent
      // sign-in in another tab can't be mistaken for an absence, and a FAILED read
      // throws past it (below) rather than clearing anything.
      if (!record) await clearData().catch(() => undefined);
      else await beginInitialSync(record.username);
      return record;
    }).then(
      (record) => {
        if (!active) return;
        if (record) adopt(record);
        else {
          setGeneration(null);
          setUsername(null);
          setStatus('unauthenticated');
        }
      },
      () => {
        // The session store couldn't be read. That is not "signed out", and it is
        // certainly not permission to clear: resolve to the sign-in screen and
        // touch nothing.
        if (active) setStatus('unauthenticated');
      },
    );
    return () => {
      active = false;
    };
  }, [adopt]);

  // The teardown, for a caller already holding the lifecycle lock (it isn't
  // re-entrant). Order:
  //   1. Delete the session record (failure leaves the library intact), then
  //      'ending' — CLOSE THE GATE FIRST, before a single byte is wiped. Without it
  //      there's a live frame where the store is empty but status is still
  //      'authenticated', so the signed-in subtree stays mounted and its liveQueries
  //      re-fire against a wiped database: every list and tag vanishes, and anything
  //      that reacts to data DISAPPEARING misfires on what looks like a mass delete.
  //      bracemark-web's links page did exactly that (page-provider read its own
  //      `?list=` as deleted and dispatched router.replace into AuthGuard's exit
  //      navigation — two navigators in one frame, which crashed sign-out). It must
  //      not be 'unauthenticated' yet either: that starts the exit navigation, and a
  //      cross-origin location.replace mid-wipe could tear the document down with
  //      decrypted bookmarks still in IndexedDB.
  //   2. the announcement — so every other context stops
  //      treating this account as current before its data goes. A stale sync cycle
  //      elsewhere is fenced by the wipe itself (sync-store.ts, AccountFencedError).
  //   3. the data. If this is interrupted, the record is already gone, so the next
  //      load finishes the wipe (hydration's no-session branch).
  //   4. react-query's in-memory cache: clearData can't reach it, and the
  //      account-scoped reads are keyed by CONSTANTS (['iap','status'], …), so a
  //      second account in this JS context would inherit the first one's answers.
  //      After the record, so an observer that refetches finds no session and sends
  //      no token.
  const teardown = useCallback(
    async (why: EndReason, requireClean = false) => {
      // A failed record deletion must not be followed by a data wipe: otherwise
      // relaunch would adopt a still-persisted session over an empty library.
      await clearSession();
      setStatus('ending');
      publishSessionChange({ generation: null, reason: why });
      let cleanupError: unknown;
      await clearData().catch((error: unknown) => {
        cleanupError = error;
      });
      queryClient.clear();
      setGeneration(null);
      setUsername(null);
      setSessionState(null);
      setReason(why);
      setStatus('unauthenticated');
      if (requireClean && cleanupError) throw cleanupError;
    },
    [queryClient],
  );

  const setSession = useCallback(
    async (credentials: SessionCredentials, options?: { newAccount?: boolean }) => {
      const record = await withSessionLock(async () => {
        const persisted = await peekSession();
        // Another account's library is still on this device — a sign-in raced a
        // context that adopted a different account. It can't be adopted over that:
        // tear it down first (a same-username sign-in is a RESUME, and keeps it).
        if (persisted && persisted.username !== credentials.username) {
          await teardown('signed-out', true);
        } else if (!persisted) {
          // Also finish residue from an interrupted/failed wipe in this process.
          // No new account may inherit it, even on a retry without a reload.
          await clearData();
        }
        if (options?.newAccount) await seedNewAccount(credentials.username);
        else await beginInitialSync(credentials.username);
        const next = activeRecord(credentials);
        await saveSession(next);
        publishSessionChange({ generation: next.generation });
        return next;
      });
      adopt(record);
    },
    [adopt, teardown],
  );

  const endSession = useCallback(
    (why: EndReason = 'signed-out') =>
      withSessionLock(async () => {
        const persisted = await loadSession();
        // The caller can be returning from a slow sign-out/delete-account request.
        // Its callback belongs to the generation visible when that action began.
        if (!persisted || persisted.generation !== generation) {
          adopt(persisted);
          return;
        }
        await teardown(why);
      }),
    [adopt, generation, teardown],
  );

  // A server verdict on the token of one generation (auth-api-client.ts). Decided
  // under the lock against the PERSISTED record, so a burst of concurrent failures
  // collapses (the second finds the work done) and a slow answer for a replaced
  // token — a resume in this or another tab — changes nothing.
  const onVerdict = useCallback(
    async ({ verdict, generation }: SessionVerdictEvent) => {
      await withSessionLock(async () => {
        let persisted: SessionRecord | null;
        try {
          persisted = await loadSession();
        } catch {
          return; // can't read the truth: preserve everything
        }
        if (!persisted || persisted.generation !== generation) {
          adopt(persisted);
          return;
        }
        // THE ONE WIPE A SERVER CAN TRIGGER: our own `session_revoked` envelope,
        // for the session this device still holds.
        if (verdict === 'revoked') {
          await teardown('revoked');
          return;
        }
        // `session_expired` / `session_unknown`: keep everything, pause sync, ask
        // for a sign-in. Persisted, so a relaunch doesn't repeat a cycle it already
        // knows will fail.
        if (persisted.state !== 'expired') {
          persisted = { ...persisted, state: 'expired' };
          await saveSession(persisted);
          publishSessionChange({ generation });
        }
        adopt(persisted);
      });
    },
    [adopt, teardown],
  );

  useEffect(
    () => onSessionVerdict((event) => void onVerdict(event).catch(() => undefined)),
    [onVerdict],
  );

  // Another context changed the record (a sign-in, a resume, an expiry, a
  // teardown) — the message is only a wake-up, so re-read the truth. Returning to
  // the foreground does the same: a tab that slept through a notification must
  // not keep acting on what it last saw.
  useEffect(() => {
    const reconcile = (message?: SessionChangeMessage) => {
      if (statusRef.current === 'loading') return; // hydration will read it
      void withSessionLock(() => loadSession()).then(
        (record) => adopt(record, message?.reason),
        () => undefined, // unreadable: leave this context as it is
      );
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') reconcile();
    };
    const offChange = onSessionChange(reconcile);
    if (typeof document === 'undefined') return offChange;
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    return () => {
      offChange();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
    };
  }, [adopt]);

  // THE PROBE (docs/sessions.md, _the expired state on the client_): while
  // expired, one authenticated request with the old token per launch or return to
  // the foreground, when online. Without it an expired device — which schedules no
  // sync — would never hear a retained `session_revoked`. Its answer goes through
  // the api client like any other: `session_revoked` for this generation wipes;
  // `session_expired`, `session_unknown`, a codeless answer or a failure change
  // nothing.
  const expired = status === 'authenticated' && sessionState === 'expired';
  useEffect(() => {
    if (!expired || typeof document === 'undefined') return;
    const probe = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      void api.call(sessionProbeEndpoint, {}).catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') probe();
    };
    probe();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', probe);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', probe);
    };
  }, [expired, api]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      isAuthenticated: status === 'authenticated',
      username,
      sessionState: status === 'authenticated' ? sessionState : null,
      reason,
      setSession,
      endSession,
    }),
    [status, username, sessionState, reason, setSession, endSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
