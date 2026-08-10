import { SignInForm } from '@stxapps/web-ui/components/auth/sign-in-form';
import { cn } from '@stxapps/web-ui/lib/utils';

import { PopupBody, PopupShell, PopupTitle } from './Shell';

import { WEB_APP_URL } from '@/utils/web-app-url';

// Signed-out popup: the SAME presentational sign-in form bracemark-web uses (shared
// from web-ui; its submit hook posts through this extension's own api client),
// inside the popup frame with no Settings action and no sync footer — neither has
// anything to show or do until there's an account.
//
// The line under the heading exists because "sign in AGAIN?" is the first thought
// of anyone who is already signed in to bracemark-web in the next tab, and the
// honest answer is a selling point rather than an apology: the encryption key is
// non-extractable and origin-bound, so the extension derives its own and keeps it
// here (docs/browser-extension.md). Saying so once costs a line and prevents the
// reading that this is a bug.
//
// The footer opens the web app's create-account page in a new tab — the extension
// does its own sign-in, but it never creates accounts itself. Styled as
// bracemark-web's own auth footer link (underlined foreground), not `text-primary`:
// in the light theme `--primary` IS very nearly the body colour, so a "link" set
// in it reads as plain text with no affordance at all.
export function SignIn() {
  return (
    <PopupShell>
      <PopupBody>
        <div className={cn('flex flex-col gap-1.5')}>
          <PopupTitle>Sign in</PopupTitle>
          <p className={cn('text-xs leading-5 text-muted-foreground')}>
            Signing in here is separate from the web app — the extension keeps its own encryption
            key in this browser.
          </p>
        </div>

        <SignInForm />

        <p className={cn('text-xs text-muted-foreground')}>
          New to Bracemark?{' '}
          <button
            type="button"
            className={cn(
              'rounded-sm font-medium text-foreground underline underline-offset-2 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            )}
            onClick={() => {
              void browser.tabs.create({ url: `${WEB_APP_URL}/create-account` });
            }}
          >
            Create an account
          </button>
        </p>
      </PopupBody>
    </PopupShell>
  );
}
