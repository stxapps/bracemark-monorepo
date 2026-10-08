'use client';

// The ordinary sign-out, as one hoisted flow — bracemark-web's links menu and
// lock pane, and the browser extension's options page, all call
// `requestSignOut()` rather than the bare `useSignOut` mutation. (The
// sync-paused notice keeps its own dialog: "Use a different account" is a
// different question with different words — docs/sessions.md.) The web sibling
// of bracemark-expo's contexts/sign-out-provider.tsx, and in THIS package
// rather than in an app because two apps need the same dialog — which is the
// one thing bracemark-expo's copy, with a single app to serve, does not have.
//
// It does two things the bare mutation left undone, and both are about the wait
// between the click and the wipe.
//
//  - IT ASKS FIRST WHEN A CHANGE HASN'T SYNCED. A sign-out erases this
//    browser's copy, the pending queue with it, and a queued change exists
//    nowhere else. The count is read at the click — one query, not a liveQuery
//    held for the life of the page — and with nothing pending there is no
//    question: the library is on the server, and a dialog on the commonest
//    path teaches people to click through the one that matters.
//  - IT COVERS THE PAGE WHILE THE SIGN-OUT RUNS. The revocation request goes out
//    before anything is erased (web-react's use-sign-out.ts), so for as long as
//    the network takes the app stayed fully usable behind a menu that had
//    already closed — and whatever was saved then was erased a moment later.
//    An AlertDialog, because it is modal and has no way out while the request
//    is in flight: no cancel button, and Escape is refused. The wait is bounded
//    by the endpoint's own deadline (SIGN_OUT_TIMEOUT_MS, @stxapps/shared).
//
// A failed sign-out says so. The mutation rejects only when the session record
// could not be deleted, in which case nothing has been erased
// (docs/data-lifecycle.md, _the sign-out teardown_) — and it used to reject
// into nothing, a click that did nothing at all.
//
// Mount it directly under the auth gate and ABOVE any app lock: the lock pane
// is one of its callers, and it must be gone before the wipe (the gate's
// 'ending' unmounts it with everything else, which is also what takes the
// dialog down on success).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { LoaderCircle } from 'lucide-react';

import { SESSION_COPY } from '@stxapps/react';
import { countPendingOps, useAuth, useSignOut } from '@stxapps/web-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';

type SignOutApi = {
  // Start a sign-out: straight to it when nothing is pending, the question
  // first when something is. A no-op while one is already under way.
  requestSignOut: () => void;
  // True from the click that commits to it until the tree unmounts (or it
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

export function SignOutProvider({ children }: { children: React.ReactNode }) {
  const { username } = useAuth();
  const { mutate, isPending, isError, isSuccess, reset } = useSignOut();
  // The flow, while there is one: how many changes were unsynced at the click.
  // Zero is the path that never asked.
  const [flow, setFlow] = useState<{ pending: number | null } | null>(null);
  // Set at the click, ahead of the state: the count is read asynchronously, so
  // a double click on the lock pane's link would otherwise get in before `flow`
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
          <AlertDialogContent data-testid="sign-out-dialog">
            <AlertDialogHeader className="place-items-start text-left">
              <AlertDialogTitle>{waitOnly ? COPY.progress : COPY.title}</AlertDialogTitle>
              <AlertDialogDescription className="text-pretty">
                {flow.pending === null
                  ? COPY.descriptionUnknown
                  : flow.pending > 0
                    ? COPY.description(flow.pending)
                    : COPY.progressDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {isError && (
              <p role="alert" data-testid="sign-out-error" className="text-sm text-destructive">
                {COPY.failed}
              </p>
            )}
            {waitOnly ? (
              // Decorative: the title above is the announcement.
              <LoaderCircle
                className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isPending}>{COPY.cancel}</AlertDialogCancel>
                {/* The pending state rides in the LABEL, not only in the dimming
                    (docs/accessibility.md — _a `disabled` button says nothing_). */}
                <AlertDialogAction
                  variant="destructive"
                  data-testid="sign-out-confirm"
                  disabled={isPending}
                  onClick={(e) => {
                    // Stay up until the sign-out lands; the auth gate takes it
                    // from there.
                    e.preventDefault();
                    mutate();
                  }}
                >
                  {isPending ? COPY.progress : isError ? COPY.retry : COPY.confirm}
                </AlertDialogAction>
              </AlertDialogFooter>
            )}
          </AlertDialogContent>
        </AlertDialog>
      )}
    </SignOutContext.Provider>
  );
}
