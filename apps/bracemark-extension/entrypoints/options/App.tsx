import { LoaderCircle } from 'lucide-react';

import { useAuth } from '@stxapps/web-react';
import { BracemarkIcon } from '@stxapps/web-ui/components/icons/bracemark-icon';
import { cn } from '@stxapps/web-ui/lib/utils';

import { AccountSection } from './AccountSection';
import { OptionsShell } from './Shell';
import { ThemeSection } from './ThemeSection';

// The Settings page — durable configuration only: the signed-in account (username +
// sign-out) plus a theme picker (the one synced setting that applies here — see
// ThemeSection). Operational state lives in the toolbar popup: sync status (and its
// detail view) is the popup's SyncPill / SyncDetail, and extraction progress is in
// bracemark-web's Settings → Extraction (the app that runs the extraction loop). This page
// holds nothing that changes on its own.
function App() {
  const { status } = useAuth();

  return (
    <OptionsShell>
      <h1 className={cn('text-xl font-semibold')}>Settings</h1>
      <p className={cn('mt-1 text-sm text-muted-foreground')}>
        Your account and how the extension looks. Lists, tags and everything else live in the
        Bracemark app.
      </p>

      {status === 'loading' ? (
        <div className={cn('flex min-h-40 items-center justify-center')}>
          <LoaderCircle
            className={cn('size-4 animate-spin text-muted-foreground motion-reduce:animate-none')}
            aria-hidden="true"
          />
          <span className={cn('sr-only')}>Loading</span>
        </div>
      ) : status !== 'authenticated' ? (
        <SignedOut />
      ) : (
        <>
          <AccountSection className={cn('mt-10')} />
          <ThemeSection className={cn('mt-10')} />
        </>
      )}
    </OptionsShell>
  );
}

// The signed-out screen. It replaced a bare sentence for the usual reason an empty
// state gets rewritten: it named the requirement ("sign in from the toolbar popup")
// without pointing at the thing to click, on a page that has no sign-in of its own
// and can't grow one — the popup owns the extension's sign-in, and this tab has no
// way to open a popup for the user.
function SignedOut() {
  return (
    <div className={cn('mt-8 rounded-xl border border-border px-6 py-12 text-center')}>
      <BracemarkIcon
        className={cn('mx-auto h-7 w-auto text-muted-foreground/40')}
        aria-hidden="true"
      />
      <p className={cn('mt-5 text-base font-medium')}>Not signed in</p>
      <p className={cn('mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground')}>
        Click the Bracemark icon in your browser toolbar and sign in there. Your account and theme
        settings appear on this page afterwards.
      </p>
    </div>
  );
}

export default App;
