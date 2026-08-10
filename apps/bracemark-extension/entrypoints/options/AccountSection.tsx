import { useAuth, useSignOut } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { OptionsSection } from './Shell';

// The account block — durable identity, not operational sync state. The signed-in
// username used to live in the popup's SyncDetail, but that surface is for the live
// sync cycle (status/pending/last sync); the username never changes and reads better
// paired with the sign-out it scopes. Together they answer "who am I, and how do I
// leave?" — see docs/browser-extension.md (the extension owns its own sign-in).
//
// The two are one bordered row rather than a label/value line with a button
// floating under it: sign-out acts on the identity named beside it, and a button
// that means "stop being THIS account" should not be separated from the account it
// ends.
//
// The line underneath says what sign-out actually does, because here it does more
// than it does on a website. clearData() wipes this browser's decrypted copy of the
// library along with the encryption key, the locks and the cached plan — that's the
// deliberate "the next person at this device inherits nothing" teardown, and it is
// worth a sentence before the click rather than a surprise after it.
export function AccountSection({ className }: { className?: string }) {
  const { username } = useAuth();
  const signOut = useSignOut();

  return (
    <OptionsSection className={className} title="Account">
      <div
        className={cn(
          'flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3',
        )}
      >
        <div className={cn('min-w-0')}>
          <p className={cn('text-xs text-muted-foreground')}>Signed in as</p>
          <p className={cn('mt-0.5 truncate text-sm font-medium')}>{username ?? '—'}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className={cn('shrink-0')}
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          {signOut.isPending ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>

      <p className={cn('mt-3 text-xs leading-5 text-muted-foreground')}>
        Signing out removes this browser’s copy of your library and its encryption key. Nothing on
        the server changes — signing back in downloads and decrypts it again.
      </p>
    </OptionsSection>
  );
}
