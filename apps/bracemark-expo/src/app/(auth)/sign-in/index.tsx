import { AuthAltAction } from '../../../features/auth/auth-alt-action';
import { AuthScreen } from '../../../features/auth/auth-screen';
import { SignInForm } from '../../../features/auth/sign-in-form';

// `/sign-in` — mirrors bracemark-web's `(auth)/sign-in/page.tsx`: the card chrome
// (AuthScreen ≈ the web layout's lockup + dog-eared Card, plus this page's
// CardHeader/Content/Footer) around the sign-in form. Thin by design — the UI
// lives in `src/features/auth/` because every file under the app root becomes a
// route (no `_`-private folders in expo-router).
//
// NO DESCRIPTION, on purpose, and this is the one asymmetry with
// /create-account. Two things rule out the line that was here ("Welcome back to
// Bracemark."): it told a returning user nothing they could act on, and this
// header is STATIC while the form under it isn't — SignInForm swaps itself for
// the recovery-code door, so any line naming the password goes stale the moment
// someone takes the other one. What's left that would hold in both modes is the
// encryption story, and AuthScreen already says that once, below the card, for
// both screens. A signup has expectations to set; a sign-in just needs to ask.
export default function SignInScreen() {
  return (
    <AuthScreen
      title="Sign in"
      footer={
        <AuthAltAction prompt="New to Bracemark?" href="/create-account" action="Create account" />
      }
    >
      <SignInForm />
    </AuthScreen>
  );
}
