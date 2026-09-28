'use client';

import { useState } from 'react';
import { CloudOff } from 'lucide-react';

import { SESSION_COPY } from '@stxapps/react';
import { useAuth, usePendingChangesCount, useSignOut } from '@stxapps/web-react';
import { SignInForm } from '@stxapps/web-ui/components/auth/sign-in-form';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@stxapps/web-ui/components/ui/alert-dialog';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@stxapps/web-ui/components/ui/dialog';

// The EXPIRED state's persistent notice (docs/sessions.md, _the expired state on
// the client_). The server answered this device's token `session_expired` or
// `session_unknown`: nothing is erased, the library opens, reads, edits and
// exports as it does offline, sync is paused, and this asks for a sign-in.
//
// Chrome, not a dialog: it sits under the links topbar and at the top of Settings
// for as long as the state lasts, and never blocks the app the way a modal would —
// the whole point of the state is that the library stays usable. The text is a
// polite status (docs/accessibility.md, _what must NOT announce_): it arrives
// asynchronously, without the user doing anything, so it must not interrupt, and
// the role rides the words rather than the buttons beside them.
export function SyncPausedNotice() {
  const { sessionState } = useAuth();
  if (sessionState !== 'expired') return null;

  return (
    <aside className="flex items-start gap-3 border-b border-border bg-muted/40 px-4 py-3">
      <CloudOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div role="status" className="flex flex-col gap-2">
          <p className="text-sm font-medium">{SESSION_COPY.paused.title}</p>
          <p className="text-sm text-muted-foreground">{SESSION_COPY.paused.description}</p>
        </div>
        <SyncPausedActions />
      </div>
    </aside>
  );
}

// The two ways out of the expired state, shared by the notice above and the
// initial-sync gate (a pause that caught a first sync mid-way):
//   - Sign in to resume: a normal sign-in with the username locked to the stored
//     one. Success replaces the token and keeps the local store; queued edits push
//     on the next cycle. A failure leaves everything as it was.
//   - Use a different account: that is a SIGN-OUT, which erases this device's
//     copy — so it warns first, with the count of edits that exist nowhere else.
export function SyncPausedActions() {
  const { username } = useAuth();
  const pending = usePendingChangesCount();
  const signOut = useSignOut();
  const [resuming, setResuming] = useState(false);
  const [switching, setSwitching] = useState(false);

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={() => setResuming(true)}>
        {SESSION_COPY.paused.resume}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setSwitching(true)}>
        {SESSION_COPY.paused.switchAccount}
      </Button>

      <Dialog open={resuming} onOpenChange={setResuming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{SESSION_COPY.resume.title}</DialogTitle>
            <DialogDescription>{SESSION_COPY.resume.description(username ?? '')}</DialogDescription>
          </DialogHeader>
          {/* Resume succeeding flips the session active, which unmounts this
              notice — and the dialog with it. */}
          {username ? <SignInForm lockedUsername={username} /> : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={switching}
        onOpenChange={(open) => !signOut.isPending && setSwitching(open)}
      >
        <AlertDialogContent>
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle>{SESSION_COPY.switchAccount.title}</AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              {SESSION_COPY.switchAccount.description(pending)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={signOut.isPending}>
              {SESSION_COPY.switchAccount.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={signOut.isPending}
              onClick={(e) => {
                // Stay up until the sign-out lands; AuthGuard takes it from there.
                e.preventDefault();
                signOut.mutate();
              }}
            >
              {signOut.isPending ? 'Signing out…' : SESSION_COPY.switchAccount.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
