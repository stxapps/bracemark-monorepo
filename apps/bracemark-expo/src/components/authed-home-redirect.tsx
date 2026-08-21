import { Redirect } from 'expo-router';

import { useAuth } from '@stxapps/expo-react';

// Authed visitors to the public landing ('/') belong in the app, so bounce them
// to /links — the same rule GuestGuard applies to /sign-in and /create-account.
//
// This has no web sibling any more. On the web the landing page moved off the app
// origin entirely, to bracemark-site on the apex (docs/hosting.md), so
// bracemark-web's `/` is now an unconditional router (components/home-redirect.tsx).
// A native app has no apex to send anyone to — its landing screen has to live in the
// binary — so `src/app/index.tsx` keeps rendering a real hero and this stays.
//
// It acts on 'authenticated' ALONE, which is also what makes it safe during a
// sign-out with no clause of its own: the other three states — including 'ending',
// the teardown frame the two guards test for explicitly — all fall through to null.
// Keep it that way. Rewriting this as "if not authenticated, redirect somewhere"
// would route from a teardown frame, which is the one thing nothing under the auth
// gate may do (docs/data-lifecycle.md, "the sign-out teardown").
//
// Renders null in loading / unauthenticated, so the landing hero shows for guests
// with no flash; it only acts once AuthProvider has hydrated to 'authenticated'.
// No ?next= here: the root is never a return target, so /links is the only
// destination. Uses expo-router's declarative <Redirect> (navigate-on-mount) in
// place of web's render-phase redirect() throw — so an authed visitor sees the
// landing for a frame before the redirect lands (vs. web unmounting before
// commit), acceptable for the rare already-signed-in-hits-root case.
export function AuthedHomeRedirect() {
  const { status } = useAuth();
  if (status === 'authenticated') return <Redirect href="/links" />;
  return null;
}
