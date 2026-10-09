'use client';

// The unlock surface shared by the two lock gates: AppLockGate renders it
// full-screen, the links page's ListLockPane renders it inside the main pane.
// One password field, inline wrong-password error, and the recovery escape
// hatch — locks are device-local (LockRecord in web-react's db.ts), so "forgot
// the password" is always solvable by signing out (which wipes every lock) and
// signing back in with the account password.

import { useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';

import { LOCK_COPY } from '@stxapps/react';
import { PasswordInput } from '@stxapps/web-ui/components/auth/password-input';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { useSignOutFlow } from '@stxapps/web-ui/contexts/sign-out-provider';
import { cn } from '@stxapps/web-ui/lib/utils';

interface LockPaneProps {
  title: string;
  description: string;
  // Resolves false on a wrong password (the pane shows the inline error);
  // anything else it may throw surfaces as the generic failure message.
  onUnlock: (password: string) => Promise<boolean>;
  // Sizing comes from the caller: `flex-1` inside the app gate's full-screen
  // wrapper, `h-full` in-pane. Pass sizing only — the root here already spends
  // its padding on `px-6 py-8`, so a safe-area utility handed in through this
  // prop would collide with it rather than stack (docs/safe-area.md); the app
  // gate insets its wrapper instead.
  className?: string;
}

export function LockPane({ title, description, onUnlock, className }: LockPaneProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { requestSignOut, signingOut } = useSignOutFlow();

  // The field takes focus as the pane goes up — unless a modal is open over it.
  // An effect, not the `autoFocus` attribute this used to be, because the
  // attribute cannot ask that question, and one host needs it asked: below `md`
  // the rail is a sheet (sidebar-drawer.tsx), and "Lock list" on the list being
  // shown mounts this pane UNDERNEATH it while it stays open. `autoFocus` then
  // pulled focus out of the sheet's focus trap and into the page the sheet had
  // marked `aria-hidden` — a focused field no screen reader could reach, and on
  // a phone a keyboard raised for an input behind the scrim. (The trap did not
  // pull it back: the button that had focus was the "Lock list" button, which
  // the same commit unmounts.) Skipped there, focus stays in the sheet, where
  // Radix parks it on the panel.
  //
  // PASSIVE on purpose. "Lock app" is chosen from a dropdown menu, which is
  // modal too and is unmounted by the very commit that mounts this pane; its
  // `aria-hidden` comes off in that commit's effect cleanups, which run before
  // this one. A layout effect would still see it and leave the app's lock
  // screen without focus. docs/locks.md, _a hand relock does not ask to be
  // undone_ — the native half withholds more, for reasons web does not share.
  const fieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const field = fieldRef.current;
    if (field && !field.closest('[aria-hidden="true"], [inert]')) field.focus();
  }, []);

  const submit = async (e: React.SubmitEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password === '') {
      setError(LOCK_COPY.errors.empty);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ok = await onUnlock(password);
      if (ok) setPassword('');
      else setError(LOCK_COPY.errors.wrong);
    } catch {
      setError(LOCK_COPY.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('flex flex-col items-center justify-center gap-4 px-6 py-8', className)}>
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Lock className="size-5 text-muted-foreground" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>

      {/* One 8/16 scale, the Field kit's (web-ui field.tsx): 16 between blocks —
          the pane's own gap, which the form matches so the button isn't held
          tighter than everything else, and 8 INSIDE the field, where the error
          belongs to the input rather than standing as a block of its own. */}
      <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-4">
        <div className="flex flex-col gap-2">
          <PasswordInput
            ref={fieldRef}
            autoComplete="off"
            placeholder={LOCK_COPY.passwordLabel}
            aria-label={LOCK_COPY.passwordLabel}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" disabled={busy}>
          {busy ? LOCK_COPY.unlocking : LOCK_COPY.unlock}
        </Button>
      </form>

      <p className="max-w-xs text-center text-xs text-muted-foreground">
        {LOCK_COPY.forgot.before}{' '}
        <button type="button" onClick={requestSignOut} disabled={signingOut} className="underline">
          {LOCK_COPY.forgot.action}
        </button>{' '}
        {LOCK_COPY.forgot.after}
      </p>
    </div>
  );
}
