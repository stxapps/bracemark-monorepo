import type { Metadata } from 'next';

import { CreateAccountForm } from '@stxapps/web-ui/components/auth/create-account-form';
import { CardContent } from '@stxapps/web-ui/components/ui/card';

import { AuthAltAction } from '../_components/auth-alt-action';

import { LegalConsent } from '@/components/legal-consent';

export const metadata: Metadata = { title: 'Create account' };

// NO CardHeader, and this is the one asymmetry with /sign-in, whose title is a
// static CardTitle at the page step. The form under this one advances
// setup → confirm → recovery, and each step now replaces the heading with its own
// ("Confirm your password", "Recovery code") — so the heading has to be rendered
// by the thing that knows the step. `step` is state local to CreateAccountForm,
// three boundaries down (web-ui package → app → route), and lifting it up here so
// this file could swap three words would be the tail wagging the dog. The header
// moved down to the state instead. StepHeader in
// `web-ui/components/auth/create-account-form.tsx` owns it, at the same
// `text-xl font-semibold tracking-tight` step /sign-in uses, and carries the
// argument for the swap.
//
// The disclosure that used to sit here — "No email address, no password reset" —
// went with it, as step one's description. It has to be seen before the ceremony
// starts, and step one is the step everyone sees; steps two and three then say
// the same thing about themselves, at the moment it bites.
export default function CreateAccountPage() {
  return (
    <>
      <CardContent>
        <CreateAccountForm />

        {/* The consent line, and it stays on the PAGE even though the header
            above it moved into the form, because the reason differs: this one
            has to hold at EVERY step, so it must not be step-aware. The form
            advances setup → confirm → recovery, and only the last step's button
            actually creates anything — but a line that appeared there would
            spring the terms on someone three screens in, next to the one control
            (Skip for now) that most needs a clear head. Naming the ACT rather
            than the button lets it be true from the first screen, which is where
            a disclosure belongs.

            It also keeps @stxapps/web-ui's CreateAccountForm free of this app's
            origins: TERMS_URL/PRIVACY_URL come from `lib/site.ts` and a package
            must never import an app, so putting it in the form would mean
            threading two hrefs across that boundary for one sentence.

            ABOVE the AuthAltAction hairline, which that component's note says
            divides "acts on this form" from "goes somewhere else". No conflict:
            the rule is there to separate two look-alike `text-sm` links, and this
            is `text-xs` fine print ABOUT this form that happens to cite two
            documents — not a third destination competing with Sign in. */}
        <LegalConsent action="creating an account" className="mt-6" />
      </CardContent>

      <AuthAltAction prompt="Already have an account?" href="/sign-in" action="Sign in" />
    </>
  );
}
