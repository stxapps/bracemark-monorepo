import { useState } from 'react';
import { LoaderCircle } from 'lucide-react';

import { useAuth } from '@stxapps/web-react';
import { BracemarkIcon } from '@stxapps/web-ui/components/icons/bracemark-icon';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { SignOutProvider } from '@stxapps/web-ui/contexts/sign-out-provider';
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
        Your account and how the extension looks. Lists, tags, and everything else live in the
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
        // SignOutProvider is the hoisted sign-out flow AccountSection calls: a
        // sync first when a save hasn't synced (the background's cycle, through
        // Providers' ExternalSyncProvider), the question for what that could not
        // send, and the cover while the sign-out runs. Inside the authenticated
        // branch, so the 'ending' status unmounts it — dialog included — before
        // the wipe.
        <SignOutProvider>
          {/* 32 between sections — bracemark-web's SettingsPane gap. This page has
              no flex column to hold a `gap`, so the step is a margin here instead of
              a gap there; the number is the one that has to match, not the mechanism. */}
          <AccountSection className={cn('mt-8')} />
          <ThemeSection className={cn('mt-8')} />
        </SignOutProvider>
      )}
    </OptionsShell>
  );
}

// The signed-out screen. The usual way here is signing out on this very page (the
// popup's gear only shows once signed in), so it hands the user straight back to a
// sign-in rather than naming one somewhere else. The sign-in stays the popup's: this
// page doesn't grow a second one (its own Argon2 runner, create-account link and
// resume view, inside a host's options dialog). "Sign in" opens the toolbar popup
// with `action.openPopup()`, and when the popup signs in, the session broadcast
// (web-react's session-store) flips this page to the signed-in view with no reload.
//
// `openPopup` is Chrome 127+, under the 111 floor, so it is feature-detected. Where
// it's missing, or the call is refused, the page falls back to pointing at the
// toolbar icon. Firefox only honours it inside a user gesture, so it must be the
// first thing the click handler does, with no `await` ahead of it.
function SignedOut() {
  const [popupRefused, setPopupRefused] = useState(false);
  const canOpenPopup = typeof browser.action?.openPopup === 'function' && !popupRefused;

  return (
    <div className={cn('mt-8 rounded-xl border border-border px-6 py-12 text-center')}>
      <BracemarkIcon
        className={cn('mx-auto h-7 w-auto text-muted-foreground')}
        aria-hidden="true"
      />
      <p className={cn('mt-5 text-base font-medium')}>Not signed in</p>
      {canOpenPopup ? (
        <>
          <p className={cn('mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground')}>
            Sign in to see your account and theme settings here.
          </p>
          <Button
            size="sm"
            className={cn('mt-5')}
            onClick={() => {
              browser.action.openPopup().catch(() => setPopupRefused(true));
            }}
          >
            Sign in
          </Button>
        </>
      ) : (
        <p className={cn('mx-auto mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground')}>
          Click the Bracemark icon in your browser toolbar and sign in there. Your account and theme
          settings appear on this page afterwards.
        </p>
      )}
    </div>
  );
}

export default App;
