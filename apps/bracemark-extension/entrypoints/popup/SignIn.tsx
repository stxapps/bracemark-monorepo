import { SESSION_COPY } from '@stxapps/react';
import { useAuth } from '@stxapps/web-react';
import { SignInForm } from '@stxapps/web-ui/components/auth/sign-in-form';
import { cn } from '@stxapps/web-ui/lib/utils';

import { PopupBody, PopupShell, PopupTitle } from './Shell';

import { openWebApp } from '@/utils/open-web-app';

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
// in it reads as plain text with no affordance at all. The decoration carries the
// hover — faint at rest so the sentence stays a sentence, solid under the pointer.
//
// THE HAIRLINE IS DOING WORK, not decorating, and it is the same argument
// bracemark-web's `(auth)/_components/auth-alt-action.tsx` makes: this line lands
// directly under SignInForm's own "Forgot your password? Use a recovery code" —
// the SAME shared form, so the same stack of two muted underlined look-alikes,
// one acting on the form you're looking at and one leaving the popup entirely.
// The rule says which is which. Full-bleed (`-mx-4 px-4` against PopupBody's
// inset) so it reads as the popup's own division rather than a short stroke
// floating in the padding — matching the header's `border-b` and Sync's footer
// row, the popup's only other two hairlines.
//
// NOT `AuthAltAction` itself, and that is deliberate rather than an oversight.
// That component lives in bracemark-web's app tree with no export path, it
// renders a `CardFooter` (there is no Card here — its `px-6` would land inside
// PopupBody's `p-4` with the `data-[size=sm]` compensation unable to fire), and
// it renders a `next/link` where a popup has to open a TAB, since it cannot
// navigate itself to the web app. bracemark-expo's twin already settled the
// precedent: same component, re-typed with an opposite class list, deliberately
// not synced. Note the popup keeps `text-xs` where both of those use `text-sm`:
// 12px is this surface's tier for every caption and aside, which `density="dense"`
// below now holds for the form's labels and its recovery door too.
//
// SO THE HIERARCHY ON THIS SCREEN READS, top to bottom: the lockup at 15px
// semibold, behind the header's own hairline — chrome, not content, and the
// popup's only carrier of the brand (brand-assets.md, _the lockup_); then
// `PopupTitle` at 14px medium, which after the density pass is the ONLY
// medium-weight non-control text in the body and so is unambiguously the
// heading; then 12px muted for the note under it, the field labels and both
// footer lines; 14px for what the user typed; and one filled 14px Button as the
// single anchor. Two body tiers, and nothing competing with the heading at its
// own size — the values sit at the heading's SIZE but not its weight, which is
// what `PopupTitle` being the body's only medium-weight text is for.
//
// Those fields read 16px until the extension started pinning web-ui's control
// type step back to its desktop tier (styles/globals.css). A 360px popup never
// matches `md:`, so they had been taking a branch that exists to stop iOS zooming
// a focused field — on a desktop, with a mouse. See input.tsx.
export function SignIn() {
  // Set when the server told this browser to forget (`session_revoked`): the local
  // copy is gone, and the popup says so rather than just reappearing signed out.
  const { reason } = useAuth();
  return (
    <PopupShell>
      <PopupBody>
        <div className={cn('flex flex-col gap-1.5')}>
          <PopupTitle>Sign in</PopupTitle>
          {reason === 'revoked' ? (
            <p role="status" className={cn('text-xs leading-5 text-muted-foreground')}>
              {SESSION_COPY.revoked}
            </p>
          ) : null}
          <p className={cn('text-xs leading-5 text-muted-foreground')}>
            Signing in here is separate from the web app — the extension keeps its own encryption
            key in this browser.
          </p>
        </div>

        {/* `dense` because this is a 360px popup, not the web app's auth card —
            see sign-in-form.tsx's density note, and Editor.tsx's List/Tags/Note
            labels, which are the same tier. */}
        <SignInForm density="dense" />

        <p className={cn('-mx-4 border-t border-border px-4 pt-4 text-xs text-muted-foreground')}>
          New to Bracemark?{' '}
          <button
            type="button"
            className={cn(
              'rounded-sm font-medium text-foreground underline decoration-foreground/40 underline-offset-2 transition-colors',
              'hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
            )}
            onClick={() => {
              void openWebApp('/create-account');
            }}
          >
            Create an account
          </button>
        </p>
      </PopupBody>
    </PopupShell>
  );
}

// "Sign in to resume" — the expired session's way back (docs/sessions.md). The same
// shared form as above, with the username locked to the account whose library is in
// this browser: success replaces the token and keeps everything local, including the
// saves queued while sync was paused. A failure leaves the paused state as it was.
export function Resume({ onBack }: { onBack: () => void }) {
  const { username } = useAuth();
  return (
    <PopupShell title={SESSION_COPY.resume.title} onBack={onBack}>
      <PopupBody>
        <p className={cn('text-xs leading-5 text-muted-foreground')}>
          {SESSION_COPY.resume.description(username ?? '')}
        </p>
        {username ? <SignInForm density="dense" lockedUsername={username} /> : null}
      </PopupBody>
    </PopupShell>
  );
}
