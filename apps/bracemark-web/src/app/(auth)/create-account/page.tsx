import type { Metadata } from 'next';

import { CREATE_ACCOUNT_COPY } from '@stxapps/react';
import { CreateAccountForm } from '@stxapps/web-ui/components/auth/create-account-form';
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@stxapps/web-ui/components/ui/card';
import { cn } from '@stxapps/web-ui/lib/utils';

import { AuthAltAction } from '../_components/auth-alt-action';

import { LegalConsent } from '@/components/legal-consent';

export const metadata: Metadata = { title: 'Create account' };

// One step, so the page owns its heading again, as /sign-in does: the title at the
// same `text-xl` sign-in's is bumped to, over the disclosure line (no email, no reset).
// The welcome that follows the button is the app's (WelcomeGate), not this page's.
export default function CreateAccountPage() {
  return (
    <>
      <CardHeader>
        <CardTitle className={cn('text-xl font-semibold tracking-tight')}>
          {CREATE_ACCOUNT_COPY.title}
        </CardTitle>
        <CardDescription>{CREATE_ACCOUNT_COPY.description}</CardDescription>
      </CardHeader>

      <CardContent>
        <CreateAccountForm />

        {/* The consent line names the ACT, on the page rather than in the form: it
            keeps @stxapps/web-ui's form free of this app's origins (TERMS_URL and
            PRIVACY_URL come from `lib/site.ts`, and a package must never import an
            app). ABOVE the AuthAltAction hairline, which divides "acts on this form"
            from "goes somewhere else": this is fine print about this form. */}
        <LegalConsent action="creating an account" className="mt-6" />
      </CardContent>

      <AuthAltAction prompt="Already have an account?" href="/sign-in" action="Sign in" />
    </>
  );
}
