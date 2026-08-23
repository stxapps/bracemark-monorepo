'use client';

// The unlock surface shared by the two lock gates: AppLockGate renders it
// full-screen, the links page's ListLockPane renders it inside the main pane.
// One password field, inline wrong-password error, and the recovery escape
// hatch — locks are device-local (LockRecord in web-react's db.ts), so "forgot
// the password" is always solvable by signing out (which wipes every lock) and
// signing back in with the account password.

import { useState } from 'react';
import { Lock } from 'lucide-react';

import { LOCK_COPY } from '@stxapps/react';
import { useSignOut } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Input } from '@stxapps/web-ui/components/ui/input';
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
  const signOut = useSignOut();

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
          <Input
            type="password"
            autoFocus
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
        <button
          type="button"
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="underline"
        >
          {LOCK_COPY.forgot.action}
        </button>{' '}
        {LOCK_COPY.forgot.after}
      </p>
    </div>
  );
}
