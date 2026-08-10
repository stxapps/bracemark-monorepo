import type { Metadata } from 'next';

import { SignInForm } from '@stxapps/web-ui/components/auth/sign-in-form';
import { CardContent, CardHeader, CardTitle } from '@stxapps/web-ui/components/ui/card';
import { cn } from '@stxapps/web-ui/lib/utils';

import { AuthAltAction } from '../_components/auth-alt-action';

export const metadata: Metadata = { title: 'Sign in' };

// The heading is sized up from CardTitle's default (`text-base font-medium`,
// which is the SECTION step — right for a settings card sitting among five
// others, wrong here where this card is the entire page) to bracemark-web's page
// step, `text-xl font-semibold tracking-tight`. Same step the settings page and
// the browser extension's options page use for their titles.
//
// NO DESCRIPTION, on purpose, and this is the one asymmetry with /create-account.
// Two things rule out the line that was here ("Welcome back to Bracemark."):
// it told a returning user nothing they could act on, and this header is STATIC
// while the form under it isn't — SignInForm swaps itself for the recovery-code
// door, so any line naming the password goes stale the moment someone takes the
// other one. What's left that would hold in both modes is the encryption story,
// and the layout already says that once, below the card, for both pages. A
// signup has expectations to set; a sign-in just needs to ask.
export default function SignInPage() {
  return (
    <>
      <CardHeader>
        <CardTitle className={cn('text-xl font-semibold tracking-tight')}>Sign in</CardTitle>
      </CardHeader>

      <CardContent>
        <SignInForm />
      </CardContent>

      <AuthAltAction prompt="New to Bracemark?" href="/create-account" action="Create account" />
    </>
  );
}
