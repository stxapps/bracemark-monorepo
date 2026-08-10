import { LegalConsent } from '../../../components/legal-consent';
import { AuthAltAction } from '../../../features/auth/auth-alt-action';
import { AuthScreen } from '../../../features/auth/auth-screen';
import { CreateAccountForm } from '../../../features/auth/create-account-form';

// `/create-account` — mirrors bracemark-web's `(auth)/create-account/page.tsx`:
// the card chrome (AuthScreen ≈ the web layout's lockup + dog-eared Card, plus
// this page's CardHeader/Content/Footer) around the shared ceremony form. Thin
// by design — the UI lives in `src/features/auth/` because every file under the
// app root becomes a route (no `_`-private folders in expo-router).
//
// NO `title`/`description`, and this is the one asymmetry with /sign-in, which
// passes AuthScreen a static title. The form under this one advances
// setup → confirm → recovery, and each step now replaces the heading with its own
// ("Confirm your password", "Recovery code") — so the heading has to be rendered
// by the thing that knows the step. `step` is state local to CreateAccountForm,
// and lifting it up here so this file could swap three words would be the tail
// wagging the dog; the header moved down to the state instead. StepHeader in
// `features/auth/create-account-form.tsx` owns it, at the same
// `text-xl font-semibold tracking-tight` step AuthScreen uses, and carries the
// argument for the swap. Web's page mirrors this exactly (no CardHeader).
//
// The disclosure that used to sit here — "No email address, no password reset" —
// went with it, as step one's description. It has to be seen before the ceremony
// starts, and step one is the step everyone sees; steps two and three then say
// the same thing about themselves, at the moment it bites.
//
// The consent line stays on the SCREEN even though the header left, because the
// reason differs: it has to hold at EVERY step, so it must not be step-aware. It
// names the act, so it is true from the first step instead of being sprung on
// someone three steps in, beside the one control (Skip for now) that most needs a
// clear head. Web's page carries the identical placement and the longer argument.
export default function CreateAccountScreen() {
  return (
    <AuthScreen
      footer={<AuthAltAction prompt="Already have an account?" href="/sign-in" action="Sign in" />}
    >
      <CreateAccountForm />
      <LegalConsent action="creating an account" className="mt-6" />
    </AuthScreen>
  );
}
