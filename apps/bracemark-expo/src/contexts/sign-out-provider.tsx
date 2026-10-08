// The ordinary sign-out, as one hoisted flow — the links menu's "Sign out" and
// the lock pane's "forgot the password" way out both call `requestSignOut()`
// rather than the bare `useSignOut` mutation. (The sync-paused notice keeps its
// own dialog: "Use a different account" is a different question with different
// words — docs/sessions.md.) Hoisted for the reason PaywallProvider is: the
// callers have no shared ancestor short of the group layout, and one of them is
// a menu item, which is gone the moment it is pressed. The web sibling is
// @stxapps/web-ui's contexts/sign-out-provider.tsx, the same flow case for case.
//
// It does two things the bare mutation left undone, and both are about the wait
// between the press and the wipe.
//
//  - IT ASKS FIRST WHEN A CHANGE HASN'T SYNCED. A sign-out erases this device's
//    copy, the pending queue with it, and a queued change exists nowhere else.
//    The count is read at the press — one query, not a live read held for the
//    life of the app — and with nothing pending there is no question: the
//    library is on the server, and a dialog on the commonest path teaches
//    people to press through the one that matters.
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
// Mounted directly under AuthGuard, ABOVE AppLockGate, and that order is the
// point: the dialog's content unmounts while a relock covers the app
// (ui/alert-dialog.tsx, useAppCovered), and the lock pane is exactly where one
// of its two callers lives. Above the gate there is no cover to read.
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

import { countPendingOps, useAuth, useSignOut } from '@stxapps/expo-react';
import { SESSION_COPY } from '@stxapps/react';

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
  // Start a sign-out: straight to it when nothing is pending, the question
  // first when something is. A no-op while one is already under way.
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
  // The flow, while there is one: how many changes were unsynced at the press.
  // Zero is the path that never asked.
  const [flow, setFlow] = useState<{ pending: number | null } | null>(null);
  // Set at the press, ahead of the state: the count is read asynchronously, so
  // a second tap on the lock pane's link would otherwise get in before `flow`
  // exists and start a second sign-out.
  const startedRef = useRef(false);
  const mountedRef = useRef(true);
  const usernameRef = useRef(username);
  usernameRef.current = username;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const requestSignOut = useCallback(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (username ? countPendingOps(username) : Promise.resolve(0))
      // Unknown is not empty. Keep sign-out available, but ask before risking
      // unsynced changes that a failed count could not rule out.
      .catch(() => null)
      .then((pending) => {
        // mutate reads the current session; this count belongs to the tree and
        // account that requested it, even if another tree has mounted meanwhile.
        if (!mountedRef.current || usernameRef.current !== username) return;
        setFlow({ pending });
        if (pending === 0) mutate();
      });
  }, [username, mutate]);

  const close = useCallback(() => {
    startedRef.current = false;
    setFlow(null);
    reset();
  }, [reset]);

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

  // The path that never asked shows only the wait. Once it has failed it needs
  // the buttons the other path has, so it takes that shape.
  const waitOnly = flow !== null && flow.pending === 0 && !isError;

  return (
    <SignOutContext.Provider value={api}>
      {children}
      {flow && (
        // Refused while the request is out: a sign-out can't be half-cancelled,
        // and behind this dialog is an app whose edits are about to be erased.
        <AlertDialog open onOpenChange={(open) => !open && !isPending && !waitOnly && close()}>
          <AlertDialogContent testID="sign-out-dialog">
            <AlertDialogHeader>
              <AlertDialogTitle>{waitOnly ? COPY.progress : COPY.title}</AlertDialogTitle>
              <AlertDialogDescription>
                {flow.pending === null
                  ? COPY.descriptionUnknown
                  : flow.pending > 0
                    ? COPY.description(flow.pending)
                    : COPY.progressDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {isError && <ErrorText testID="sign-out-error">{COPY.failed}</ErrorText>}
            {waitOnly ? (
              // Decorative: the title above is the announcement.
              <ActivityIndicator size="small" aria-hidden />
            ) : (
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPending}>
                  <Text>{COPY.cancel}</Text>
                </AlertDialogCancel>
                {/* The pending state rides in the LABEL, not only in the dimming
                    (docs/accessibility.md — _a `disabled` button says nothing_). */}
                <Button
                  variant="destructive"
                  testID="sign-out-confirm"
                  disabled={isPending}
                  onPress={() => mutate()}
                >
                  <Text>{isPending ? COPY.progress : isError ? COPY.retry : COPY.confirm}</Text>
                </Button>
              </AlertDialogFooter>
            )}
          </AlertDialogContent>
        </AlertDialog>
      )}
    </SignOutContext.Provider>
  );
}
