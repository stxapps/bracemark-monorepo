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
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';

import { useApiClient } from '@stxapps/react';
import { newSessionGeneration, sessionProbeEndpoint, type SessionState } from '@stxapps/shared';

import { clearData } from '../data/clear-data';
import {
  activeRecord,
  clearSession,
  loadSession,
  onSessionVerdict,
  saveSession,
  type SessionCredentials,
  type SessionRecord,
  type SessionVerdictEvent,
  withSessionLock,
} from '../data/session-store';
import { beginInitialSync, seedNewAccount } from '../data/sync-store';

// App-level auth state — the expo sibling of web-react's contexts/auth-provider,
// and THE LIFECYCLE OWNER on this platform (docs/sessions.md, _who acts on a
// 401_): the main app process is the only code that writes session state or wipes
// the device. The separate-process iOS share extension inherits the session out of
// the shared-Keychain mirror (session-store) and never acts on a verdict. Only
// `username`/`status`/`sessionState` enter React state — the bearer token and the
// raw `encryptionKey` bytes stay in the session store (read where needed via
// getSession), keeping key material out of the component tree.
//
// ⚠ WHAT MAY WIPE THIS DEVICE. Exactly two things: an explicit sign-out here
// (endSession), or a `session_revoked` verdict from bracemark-api for the session
// generation still persisted here. Expiry and an unknown token KEEP everything and
// enter the expired state. No clock, no other status, no codeless or foreign 401
// — and no failed storage read — may reach a wipe.

// 'ending' is the TEARDOWN frame: a wipe has started but hasn't finished. It
// exists so the gates can close the app group BEFORE the local store empties under
// it — see teardown. Treat it exactly like 'loading' at every gate (render
// nothing, decide nothing); it is deliberately NOT 'unauthenticated', which is the
// state that fires the exit <Redirect>. Same four states as web-react's provider,
// and the pair must stay in step: the ordering rule is the state machine's, so a
// platform that quietly drops the phase re-opens the frame for whatever it adds
// next.
type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'ending';
// Why we left 'authenticated'. Lets the AuthGuard pick the right destination: a
// deliberate 'signed-out' goes home to '/', while 'revoked' (the server told this
// device to forget) or a direct launch (reason null) goes to /sign-in, which says
// why. An EXPIRED session never leaves the app: it stays 'authenticated' with
// sessionState 'expired'.
type EndReason = 'signed-out' | 'revoked';

interface AuthContextValue {
  status: AuthStatus;
  isAuthenticated: boolean;
  username: string | null;
  // 'active' or 'expired' while authenticated, null otherwise. Expired: the
  // library is fully usable, sync is paused, and "Sign in to resume" is on screen.
  sessionState: SessionState | null;
  // Set when status is 'unauthenticated'; null on a fresh launch that never had a
  // session.
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
  // Defaults to a deliberate 'signed-out' (→ '/').
  endSession: (reason?: EndReason) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // 'loading' until hydration resolves, so auth-gated navigation can hold off
  // instead of flashing a signed-out screen on cold start (there's no SSR here,
  // but the secure-store read is still async).
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

  const usernameRef = useRef(username);
  usernameRef.current = username;

  // Show a persisted record in React state.
  const adopt = useCallback(
    (record: SessionRecord) => {
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

  // Hydrate from secure-store once on mount, under the lifecycle lock. No clock is
  // consulted: a record is signed in, in whatever state it was persisted with,
  // however old it is.
  useEffect(() => {
    let active = true;
    withSessionLock(async () => {
      let record = await loadSession();
      // A record from before the session redesign has no generation (and a stale
      // `expiresAt`, dropped unread). It is an ACTIVE session, not a corrupt one.
      if (record && !record.generation) {
        record = { ...record, generation: newSessionGeneration() };
        await saveSession(record);
      }
      // No session: finish any interrupted teardown. The local store holds
      // DECRYPTED bookmarks (and lock verifiers), plus on-disk plaintext `files/`
      // blobs, so residue must go before the next account signs in here:
      // clearData's table wipe is one transaction, but the file-system deletes
      // can't join it (different medium), so a launch killed mid-clear can leave
      // orphan plaintext blobs with no rows. Decided by the read just made, and a
      // FAILED read throws past it rather than clearing anything.
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
        // secure-store couldn't be read. Not "signed out", and never permission
        // to clear: resolve to the sign-in screen and touch nothing.
        if (active) setStatus('unauthenticated');
      },
    );
    return () => {
      active = false;
    };
  }, [adopt]);

  // The teardown, for a caller already holding the lifecycle lock. Order:
  //   1. Delete the session record (failure leaves the library intact), then
  //      'ending' — CLOSE THE GATE FIRST, before a single byte is wiped. Without it
  //      there's a live frame where the store is empty but status is still
  //      'authenticated', so the signed-in group stays mounted and its queries
  //      re-read a wiped database. Nothing here auto-navigates on data vanishing
  //      TODAY (this client keeps its selection in React state, not a URL), but
  //      web's links page did, and it crashed sign-out (docs/data-lifecycle.md,
  //      _the sign-out teardown_). And not 'unauthenticated' yet: that fires the
  //      exit <Redirect> while decrypted bookmarks are still in sqlite, in a
  //      process that OUTLIVES a sign-out — no reload cleans up behind it.
  //   2. the session record (and its shared-Keychain mirror) — so the iOS share
  //      extension stops using the token before the data goes, and an interrupted
  //      wipe is finished by the next launch (hydration's no-session branch).
  //   3. the data. A sync cycle still in flight is fenced by the wipe itself
  //      (sync-store.ts, AccountFencedError).
  //   4. react-query's in-memory cache, keyed by CONSTANTS (['iap','status'], …) —
  //      clearData can't reach it, and a second account in this process would
  //      inherit the first one's answers.
  const teardown = useCallback(
    async (why: EndReason, requireClean = false) => {
      // A failed record deletion must not be followed by a data wipe: otherwise
      // relaunch would adopt a still-persisted session over an empty library.
      await clearSession();
      setStatus('ending');
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
        const persisted = await loadSession();
        // Another account's library is still on this device: tear it down before
        // adopting a new one (a same-username sign-in is a RESUME, and keeps it).
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
          if (persisted) adopt(persisted);
          return;
        }
        await teardown(why);
      }),
    [adopt, generation, teardown],
  );

  // A server verdict on the token of one generation (auth-api-client.ts), decided
  // under the lock against the PERSISTED record: a burst of concurrent failures
  // collapses, and a slow answer for a replaced token changes nothing.
  const onVerdict = useCallback(
    async ({ verdict, generation }: SessionVerdictEvent) => {
      await withSessionLock(async () => {
        let persisted: SessionRecord | null;
        try {
          persisted = await loadSession();
        } catch {
          return; // can't read the truth: preserve everything
        }
        if (!persisted || persisted.generation !== generation) return;
        // THE ONE WIPE A SERVER CAN TRIGGER: our own `session_revoked` envelope,
        // for the session this device still holds.
        if (verdict === 'revoked') {
          await teardown('revoked');
          return;
        }
        // `session_expired` / `session_unknown`: keep everything, pause sync, ask
        // for a sign-in. Persisted (and mirrored to the iOS share extension, which
        // then stops calling the api).
        if (persisted.state !== 'expired') {
          persisted = { ...persisted, state: 'expired' };
          await saveSession(persisted);
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

  // THE PROBE (docs/sessions.md, _the expired state on the client_): while
  // expired, one authenticated request with the old token per launch or return to
  // the foreground. Without it an expired device — which schedules no sync —
  // would never hear a retained `session_revoked`. Its answer goes through the api
  // client like any other; a failure (offline included) changes nothing.
  const expired = status === 'authenticated' && sessionState === 'expired';
  useEffect(() => {
    if (!expired) return;
    const probe = () => void api.call(sessionProbeEndpoint, {}).catch(() => undefined);
    probe();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') probe();
    });
    return () => sub.remove();
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
