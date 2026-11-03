import { CREATE_ACCOUNT_COPY } from '@stxapps/react';

import { LegalConsent } from '../../../components/legal-consent';
import { AuthAltAction } from '../../../features/auth/auth-alt-action';
import { AuthScreen } from '../../../features/auth/auth-screen';
import { CreateAccountForm } from '../../../features/auth/create-account-form';

// `/create-account` — mirrors bracemark-web's `(auth)/create-account/page.tsx`: the
// card chrome (AuthScreen ≈ the web layout's lockup + dog-eared Card) around the
// one-step form. Thin by design — the UI lives in `src/features/auth/` because every
// file under the app root becomes a route (no `_`-private folders in expo-router).
//
// One step, so the screen owns its heading, as /sign-in does: the title over the
// disclosure line (no email address, no reset), which has to be read before the
// account is made. The welcome after it is the app's (components/welcome-gate.tsx).
//
// The consent line names the ACT, under the form: it is about this form.
export default function CreateAccountScreen() {
  return (
    <AuthScreen
      title={CREATE_ACCOUNT_COPY.title}
      description={CREATE_ACCOUNT_COPY.description}
      footer={<AuthAltAction prompt="Already have an account?" href="/sign-in" action="Sign in" />}
    >
      <CreateAccountForm />
      <LegalConsent action="creating an account" className="mt-6" />
    </AuthScreen>
  );
}
