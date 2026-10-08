import { useAuth } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { useSignOutFlow } from '@stxapps/web-ui/contexts/sign-out-provider';
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
// ends. Its measures are bracemark-web's SettingsRow (`gap-3`, `p-4`) — that
// component lives in bracemark-web's app tree with no export path, so this is a
// re-typing of it rather than an import, the same precedent SignIn.tsx and
// bracemark-expo's own settings-kit already set.
//
// SIGN-OUT LIVES IN THE ACCOUNT SECTION ONLY IN THIS APP, and the extra button is
// not drift. bracemark-web's Account section deliberately has none — its links
// topbar's more-options menu owns sign-out, and bracemark-expo's does the same, so
// both leave the section to the durable identity above. There is no topbar here to
// own it: the popup has no menu, and this page has no header at all (Shell.tsx
// carries why), which leaves this row as the extension's only way out of a session.
// The label follows from that. Both of the others print "Username" — the noun, as a
// row in a list of rows — but a noun beside a control that acts on the SESSION
// rather than on the value reads as a field with a stray button next to it, where
// "Signed in as <name> [Sign out]" reads as one statement. If sign-out ever moves
// off this row, this goes back to "Username".
//
// The line underneath says what sign-out actually does, because here it does more
// than it does on a website. clearData() wipes this browser's decrypted copy of the
// library along with the encryption key, the locks and the cached plan — that's the
// deliberate "the next person at this device inherits nothing" teardown, and it is
// worth a sentence before the click rather than a surprise after it.
//
// That sentence covers the copy that can be downloaded again. What it cannot cover
// is a save that never reached the server — the popup queues one whenever it is
// offline — so the click goes through the hoisted sign-out flow (@stxapps/web-ui's
// sign-out-provider, mounted in App.tsx), which stops to ask when the queue is not
// empty and says how many.
export function AccountSection({ className }: { className?: string }) {
  const { username } = useAuth();
  const { requestSignOut, signingOut } = useSignOutFlow();

  return (
    <OptionsSection className={className} title="Account">
      <div
        className={cn(
          'flex items-center justify-between gap-3 rounded-lg border border-border p-4',
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
          disabled={signingOut}
          onClick={requestSignOut}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>

      <p className={cn('mt-3 text-sm leading-6 text-muted-foreground')}>
        Signing out removes this browser’s copy of your library and its encryption key. Nothing on
        the server changes — signing back in downloads and decrypts it again.
      </p>
    </OptionsSection>
  );
}
