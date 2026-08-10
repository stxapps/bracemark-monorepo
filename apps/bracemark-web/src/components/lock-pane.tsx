'use client';

// The unlock surface shared by the two lock gates: AppLockGate renders it
// full-screen, the links page's ListLockPane renders it inside the main pane.
// One password field, inline wrong-password error, and the recovery escape
// hatch — locks are device-local (LockRecord in web-react's db.ts), so "forgot
// the password" is always solvable by signing out (which wipes every lock) and
// signing back in with the account password.

import { useState } from 'react';
import { Lock } from 'lucide-react';

import { useSignOut } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Input } from '@stxapps/web-ui/components/ui/input';
import { cn } from '@stxapps/web-ui/lib/utils';

export function LockPane({
  title,
  description,
  onUnlock,
  className,
}: {
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
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signOut = useSignOut();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (password === '') {
      setError('Please enter a password');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const ok = await onUnlock(password);
      if (ok) setPassword('');
      else setError('Password is not correct. Please try again.');
    } catch {
      setError('Could not unlock. Please try again.');
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

      <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-3">
        <Input
          type="password"
          autoFocus
          autoComplete="off"
          placeholder="Password"
          aria-label="Password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (error) setError(null);
          }}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      </form>

      <p className="max-w-xs text-center text-xs text-muted-foreground">
        Forgot the password? You can{' '}
        <button
          type="button"
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="underline"
        >
          sign out
        </button>{' '}
        and sign back in — signing out removes all locks on this device.
      </p>
    </div>
  );
}
