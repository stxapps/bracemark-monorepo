// The ordinary sign-out, as one hoisted flow — the links menu's "Sign out" and
// the lock pane's "forgot the password" way out both call `requestSignOut()`
// rather than the bare `useSignOut` mutation. (The sync-paused notice keeps its
// own dialog: "Use a different account" is a different question with different
// words — docs/sessions.md.) Hoisted for the reason PaywallProvider is: the
// callers have no shared ancestor short of the group layout, and one of them is
// a menu item, which is gone the moment it is pressed. The web sibling is
// @stxapps/web-ui's contexts/sign-out-provider.tsx, the same flow case for case.
//
// It does three things the bare mutation left undone, and all of them are about
// the wait between the press and the wipe.
//
//  - IT SYNCS FIRST WHEN A CHANGE HASN'T. A sign-out erases this device's copy,
//    the pending queue with it, and a queued change exists nowhere else. The
//    count is read at the press — one query, not a live read held for the life
//    of the app — and with nothing pending there is no question: the library is
//    on the server, and a dialog on the commonest path teaches people to press
//    through the one that matters. With something pending the flow runs one
//    sync cycle and reads the count again, and a queue that emptied signs out
//    with no question either. It used to ask at once and say "cancel and sync
//    first" — which the app can do itself, and which the app-lock pane's
//    "forgot the password" caller cannot do at all: behind the lock there is no
//    sync to press, and nothing here runs a cycle after a relock on its own.
//    The wait is bounded and can be cancelled (@stxapps/react's
//    sync-before-sign-out.ts); nothing is erased during it.
//  - IT ASKS ABOUT WHAT THE SYNC COULD NOT SAVE. Still pending after the cycle
//    — offline, an expired session, an account over its limit — or a queue
//    that cannot be read: those changes are about to be lost for good, and that
//    takes the user's own confirmation.
//  - IT COVERS THE APP WHILE THE SIGN-OUT RUNS. The revocation request goes out
//    before anything is erased (use-sign-out.ts), so for as long as the network
//    takes the app was fully usable behind a menu that had already closed — and
//    whatever was saved then was erased a moment later. An AlertDialog rather
//    than a spinner in the menu because it is modal, and has no way out while
//    the request is in flight: no cancel button, and the scrim and the Android
//    back button are both refused. The wait is bounded by the endpoint's own
//    deadline (SIGN_OUT_TIMEOUT_MS, @stxapps/shared).
//
// A failed sign-out says so. The mutation rejects only when the session record
// could not be deleted, in which case nothing has been erased
// (docs/data-lifecycle.md, _the sign-out teardown_) — and it used to reject
// into nothing, a press that did nothing at all.
//
// Mounted inside SyncProvider — `useSync` is where the cycle comes from — and
// ABOVE AppLockGate, and that second order is the point: the dialog's content
// unmounts while a relock covers the app (ui/alert-dialog.tsx, useAppCovered),
// and the lock pane is exactly where one of its two callers lives. Above the
// gate there is no cover to read.
//
// This file is also where the app layer's own share of the teardown lives — see
// the effect at the bottom of the provider.

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
import { ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';

import { countPendingOps, getSession, useAuth, useSignOut, useSync } from '@stxapps/expo-react';
import { SESSION_COPY, syncBeforeSignOut } from '@stxapps/react';

import { ErrorText } from '../components/error-text';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Button } from '../components/ui/button';
import { Text } from '../components/ui/text';

type SignOutApi = {
  // Start a sign-out: straight to it when nothing is pending, a sync first
  // when something is, and the question only for what that sync left behind.
  // A no-op while one is already under way.
  requestSignOut: () => void;
  // True from the press that commits to it until the tree unmounts (or it
  // fails) — for a caller that wants to stop offering the action meanwhile.
  signingOut: boolean;
};

const SignOutContext = createContext<SignOutApi | null>(null);

export function useSignOutFlow(): SignOutApi {
  const ctx = useContext(SignOutContext);
  if (!ctx) throw new Error('useSignOutFlow must be used within <SignOutProvider>');
  return ctx;
}

const COPY = SESSION_COPY.signOut;

export function SignOutProvider({ children }: { children: ReactNode }) {
  const { username } = useAuth();
  const { mutate, isPending, isError, isSuccess, reset } = useSignOut();
  const { syncAndWait } = useSync();
  // The flow, while there is one: how many changes are unsynced, and whether
  // the sync that might save them is still out. Zero is the path that never
  // asks; `null` is a queue that could not be read.
  const [flow, setFlow] = useState<{
    pending: number | null;
    syncing: boolean;
    generation: string | null;
  } | null>(null);
  // Set at the press, ahead of the state: the count is read asynchronously, so
  // a second tap on the lock pane's link would otherwise get in before `flow`
  // exists and start a second sign-out.
  const startedRef = useRef(false);
  // Which flow is current. A cancel during the sync leaves that flow's
  // continuation waiting on the cycle; it must find itself superseded when the
  // cycle settles, not carry on into a sign-out nobody is asking for any more.
  const flowIdRef = useRef(0);
  const mountedRef = useRef(true);
  const usernameRef = useRef(username);
  usernameRef.current = username;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const close = useCallback(() => {
    startedRef.current = false;
    flowIdRef.current += 1;
    setFlow(null);
    reset();
  }, [reset]);

  const requestSignOut = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const id = ++flowIdRef.current;
    const generation = getSession()?.generation ?? null;
    // Unknown is not empty. Keep sign-out available, but ask before risking
    // unsynced changes that a failed count could not rule out.
    const count = () =>
      (username ? countPendingOps(username) : Promise.resolve(0)).catch(() => null);
    // mutate reads the current session; this flow belongs to the tree and
    // account that requested it, even if another tree has mounted meanwhile —
    // and to the press that started it, not one cancelled since.
    const stale = () => {
      if (!mountedRef.current || flowIdRef.current !== id) return true;
      // A same-account resume also replaces the session. Release this flow's
      // cover and latch so a fresh request can target the replacement.
      if (usernameRef.current !== username || (getSession()?.generation ?? null) !== generation) {
        close();
        return true;
      }
      return false;
    };
    // Neither read rejects and neither does the bounded sync, so nor does this.
    void (async () => {
      let pending = await count();
      if (stale()) return;
      if (pending !== 0) {
        setFlow({ pending, syncing: true, generation });
        await syncBeforeSignOut(syncAndWait);
        if (stale()) return;
        // The queue, not the cycle's outcome, is the answer: a cycle can fail
        // after pushing everything, and complete with part of it refused.
        pending = await count();
        if (stale()) return;
      }
      setFlow({ pending, syncing: false, generation });
      if (pending === 0) mutate({ generation });
    })();
  }, [username, mutate, syncAndWait, close]);

  // A resumed session survives the old generation's sign-out. In that case
  // AuthGuard keeps us mounted, so success must release the cover here.
  useEffect(() => {
    if (isSuccess) close();
  }, [isSuccess, close]);

  const api = useMemo<SignOutApi>(
    () => ({ requestSignOut, signingOut: isPending }),
    [requestSignOut, isPending],
  );

  // The app layer's own share of the teardown. expo-image keeps what it has
  // decoded in memory (features/links/link-media.tsx — `cachePolicy="memory"`,
  // so nothing of it is on disk), and those are the previews of the links that
  // were on screen: plaintext that clearData cannot reach, because the cache
  // belongs to a module @stxapps/expo-react does not depend on. As an unmount
  // cleanup rather than a step of the flow above, so that it runs for EVERY end
  // of a session — a revocation and delete-account never pass through
  // requestSignOut, and all three unmount this.
  useEffect(
    () => () => {
      void Image.clearMemoryCache().catch(() => undefined);
    },
    [],
  );

  // The first wait: nothing is erased while the sync is out, so this one can be
  // cancelled.
  const syncing = flow !== null && flow.syncing;
  // The path that never asked shows only the wait. Once it has failed it needs
  // the buttons the other path has, so it takes that shape.
  const waitOnly = flow !== null && !flow.syncing && flow.pending === 0 && !isError;

  return (
    <SignOutContext.Provider value={api}>
      {children}
      {flow && (
        // Refused while the request is out: a sign-out can't be half-cancelled,
        // and behind this dialog is an app whose edits are about to be erased.
        <AlertDialog open onOpenChange={(open) => !open && !isPending && !waitOnly && close()}>
          <AlertDialogContent testID="sign-out-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {syncing ? COPY.syncing : waitOnly ? COPY.progress : COPY.title}
              </AlertDialogTitle>
              {/* Polite, not an alert: what replaces the sync's line arrives on
                  its own, some seconds after the press, and nothing else would
                  say the dialog now asks a question (docs/accessibility.md —
                  _what must NOT announce_, the availability verdict). TalkBack
                  only; VoiceOver has no live regions. */}
              <AlertDialogDescription aria-live="polite">
                {syncing
                  ? COPY.syncingDescription(flow.pending)
                  : flow.pending === null
                    ? COPY.descriptionUnknown
                    : flow.pending > 0
                      ? COPY.description(flow.pending)
                      : COPY.progressDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {isError && <ErrorText testID="sign-out-error">{COPY.failed}</ErrorText>}
            {(syncing || waitOnly) && (
              // Decorative: the title above is the announcement.
              <ActivityIndicator size="small" aria-hidden />
            )}
            {!waitOnly && (
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPending}>
                  <Text>{COPY.cancel}</Text>
                </AlertDialogCancel>
                {/* Nothing to confirm while the sync is out — only the way back.
                    The pending state rides in the LABEL, not only in the dimming
                    (docs/accessibility.md — _a `disabled` button says nothing_). */}
                {!syncing && (
                  <Button
                    variant="destructive"
                    testID="sign-out-confirm"
                    disabled={isPending}
                    onPress={() => {
                      if ((getSession()?.generation ?? null) !== flow.generation) close();
                      else mutate({ generation: flow.generation });
                    }}
                  >
                    <Text>{isPending ? COPY.progress : isError ? COPY.retry : COPY.confirm}</Text>
                  </Button>
                )}
              </AlertDialogFooter>
            )}
          </AlertDialogContent>
        </AlertDialog>
      )}
    </SignOutContext.Provider>
  );
}
