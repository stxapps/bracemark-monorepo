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

import { clearData } from '../data/clear-data';
import {
  clearSession,
  loadSession,
  onSessionInvalid,
  saveSession,
  type SessionRecord,
} from '../data/session-store';

// App-level auth state — the expo sibling of web-react's contexts/auth-provider.
// Account creation / sign-in happen in the app and land a SessionRecord here; the
// separate-process iOS share extension inherits the session out of secure-store
// (session-store) rather than running this provider. Only `username`/`status` enter
// React state — the bearer token and the raw `encryptionKey` bytes stay in the
// session store (read where needed via getToken/getSession), keeping key material
// out of the component tree.

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';
// Why we left 'authenticated'. Lets the AuthGuard pick the right destination: a
// deliberate 'signed-out' goes home to '/', while 'expired' (or a direct visit,
// reason null) goes to /sign-in?next= so the user can resume where they were.
type EndReason = 'signed-out' | 'expired';

interface AuthContextValue {
  status: AuthStatus;
  isAuthenticated: boolean;
  username: string | null;
  // Set when status is 'unauthenticated'; null on a fresh launch that never had a
  // session. AuthGuard reads it to choose home vs. /sign-in?next=.
  reason: EndReason | null;
  // Adopt a freshly created / signed-in session: persist it and flip to authed.
  setSession: (record: SessionRecord) => Promise<void>;
  // Drop the LOCAL session only — the sign-out PRIMITIVE. Server-side revocation
  // lives in the user-driven useSignOut hook (which POSTs sign-out, then calls
  // this); this stays local so it can also serve the onSessionInvalid path, where
  // the token is already dead. The reason it records steers AuthGuard's post-
  // sign-out redirect: defaults to a deliberate 'signed-out' (→ '/'); the
  // invalid-session path passes 'expired'.
  endSession: (reason?: EndReason) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // 'loading' until hydration resolves, so auth-gated navigation can hold off
  // instead of flashing a signed-out screen on cold start (there's no SSR here,
  // but the secure-store read is still async).
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [username, setUsername] = useState<string | null>(null);
  const [reason, setReason] = useState<EndReason | null>(null);
  // For the sign-out wipe below: the react-query cache is the one per-account
  // store clearData can't reach (it's in-memory React state, not a device store).
  const queryClient = useQueryClient();

  // Hydrate from secure-store once on mount. An expired session is cleared and
  // treated as signed-out.
  useEffect(() => {
    let active = true;
    loadSession()
      .then((s) => {
        if (!active) return;
        if (s && s.expiresAt > Date.now()) {
          setUsername(s.username);
          setStatus('authenticated');
        } else {
          // Same wipe as endSession, run whenever we resolve to signed-out — not
          // only on an expired session. The local store holds DECRYPTED bookmarks
          // (and lock verifiers), plus on-disk plaintext `files/` blobs, so any
          // residue must go before the next account signs in on this device.
          // Running it in the no-session case too closes the interrupted-exit gap:
          // clearData's table wipe is one transaction, but the file-system deletes
          // can't join it (different medium), so a launch killed mid-clear can
          // leave orphan plaintext blobs with no rows; this catches them on next
          // load (a guest reaches /sign-in only unauthenticated, and only after a
          // fresh launch, so this always runs first). clearSession with no session
          // is a no-op. A stored-but-expired session additionally records 'expired'
          // so AuthGuard resumes the user at /sign-in?next=; no session at all
          // stays null (a direct launch). No queryClient.clear() here (unlike
          // endSession): this runs on mount of a fresh launch, cache still empty.
          void Promise.allSettled([clearSession(), clearData()]);
          if (s) setReason('expired');
          setUsername(null);
          setStatus('unauthenticated');
        }
      })
      .catch(() => {
        if (active) setStatus('unauthenticated');
      });
    return () => {
      active = false;
    };
  }, []);

  const setSession = useCallback(async (record: SessionRecord) => {
    await saveSession(record);
    setUsername(record.username);
    setReason(null);
    setStatus('authenticated');
  }, []);

  const endSession = useCallback(
    async (reason: EndReason = 'signed-out') => {
      // Drop the session AND the synced local data together. The local store holds
      // DECRYPTED bookmarks (plus on-disk plaintext blobs), so leaving them behind
      // would let the next user on this device read the previous user's plaintext.
      // One active session per device (see session-store), so a full wipe is
      // correct; both clears run regardless of which one rejects. Covers the
      // onSessionInvalid (expired) path too.
      await Promise.allSettled([clearSession(), clearData()]);

      // The third per-account store: react-query's in-memory cache. clearData
      // can't reach it (it wipes DEVICE stores), and the account-scoped server
      // reads are keyed by CONSTANTS — ['iap','status'], hasRecoveryDoorQueryKey —
      // not by userId. So without this, signing in as a different account inherits
      // the previous account's cached answers: the subscription read is the worst
      // of them (staleTime 5min means it isn't even refetched on mount, and
      // useEntitlements would then persist the wrong plan into the new account's
      // device cache). Bites harder here than on web — the app process outlives a
      // sign-out, so there's no reload to save us. Wiping the whole cache is right
      // for the same reason the data wipe isn't account-scoped.
      //
      // Ordering is load-bearing: this runs AFTER clearSession, so an observer
      // that hasn't unmounted yet can only refetch with no token AND no session
      // record — authFetch's expired-mid-session branch stays quiet
      // (lib/auth-api-client.ts), so the wipe can't bounce back through
      // onSessionInvalid and overwrite this sign-out's reason with 'expired'.
      queryClient.clear();

      setUsername(null);
      setReason(reason);
      setStatus('unauthenticated');
    },
    [queryClient],
  );

  // React to the api client detecting an invalid session (server 401, or a
  // mid-session token expiry) by dropping to signed-out. AuthGuard then bounces
  // protected routes to /sign-in. The ref collapses a burst of concurrent failing
  // requests into a single endSession — set synchronously before the async call,
  // so it doesn't lean on clearSession's internal timing — and resets after so a
  // later re-login can be invalidated again.
  const invalidating = useRef(false);

  useEffect(
    () =>
      onSessionInvalid(() => {
        if (invalidating.current) return;

        invalidating.current = true;
        void endSession('expired').finally(() => {
          invalidating.current = false;
        });
      }),
    [endSession],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      isAuthenticated: status === 'authenticated',
      username,
      reason,
      setSession,
      endSession,
    }),
    [status, username, reason, setSession, endSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
