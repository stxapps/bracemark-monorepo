import { cn } from '@stxapps/web-ui/lib/utils';

import { DogEaredCard, FocusedPage } from '@/components/focused-page';
import { GuestGuard } from '@/components/guest-guard';

// Shared chrome for the auth routes (/create-account, /sign-in): a centered
// column on a full-height background. No nav — these pages are intentionally
// focused. Each page fills the card with its own CardHeader/Content/Footer.
// GuestGuard bounces already-authenticated visitors to /links — including right
// after create-account/sign-in, once setSession flips auth state.
//
// The surface itself — the insets, the height, the background, the brand lockup
// and the dog-eared card — is `components/focused-page.tsx`, shared with the 404
// and the error boundary. It started here; it moved the day those two needed the
// same screen and couldn't be given a layout to inherit it from.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <GuestGuard>
      <FocusedPage>
        <DogEaredCard>{children}</DogEaredCard>

        {/* Why the account behaves the way it does — no email field, no reset
            link, a password ceremony that insists you save something. Said once
            here, quietly, under both pages, so neither form has to re-argue it.
            Both halves are literal (docs/account.md, "a password-unlocked
            wallet"): the DEK never leaves the client, and the server stores a
            wrapped key it cannot unwrap. Don't inflate this into a marketing
            line — it's load-bearing context for the next thing the user does.

            `px-6` matches the card's own inset, and it is what puts this line on
            the SAME text axis as everything else on the screen: the wordmark, the
            card title, the field labels, the alt-action sentence. Without it the
            note is the only text on the page hanging 24px out to the left, against
            the card's OUTER edge — an edge nothing else sets type to. Centring it
            is worse than either: `text-balance` evens the two lines, so a centred
            block lands a few px off the axis with a ragged left edge and reads as
            a mistake rather than a choice. Not shared with the card in code — this
            <p> is a sibling of DogEaredCard, not a child — so the two 1.5rem
            values have to be kept level by hand. Same slot, same classes, in
            `app/not-found.tsx` and `app/error.tsx`. */}
        <p className={cn('px-6 text-xs leading-5 text-balance text-muted-foreground')}>
          Your links are encrypted on your device before they’re stored. Bracemark’s servers never
          see your password.
        </p>
      </FocusedPage>
    </GuestGuard>
  );
}
