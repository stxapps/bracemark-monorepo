import { type ReactNode } from 'react';
import { Redirect } from 'expo-router';

import { useAuth } from '@stxapps/expo-react';

// What `/` SHOWS — the one route in the app that serves two audiences: a guest
// gets the landing hero (components/landing.tsx), an authenticated visitor gets
// bounced to /links, and until AuthProvider has hydrated NOBODY gets anything.
//
// That last clause is why this takes children instead of sitting beside
// <Landing> as a bare redirect. `src/app/index.tsx` is the LAUNCH route — no
// deep link, no restored navigation state — so every cold start of a signed-in
// user passes through here, not the rare direct-hit-on-root this was first
// written for. An unconditional hero would paint "Create account" / "Sign in" at
// them for the whole of the secure-store read PLUS the frame the <Redirect>
// takes to commit, on every launch. Withholding it costs a guest the same beat
// of bg-background that AuthGuard, GuestGuard, AppLockGate and InitialSyncGate
// each already spend: a guard or a gate renders NOTHING while it is still
// deciding, as a semantic guarantee rather than a timing race (docs/locks.md,
// the no-flash pair). If that beat ever needs closing, the lever is the native splash —
// `SplashScreen.preventAutoHideAsync()` at the root, hidden once `status` leaves
// 'loading' — not a loading screen here, which would just be a second flash.
//
// This has no web sibling any more. On the web the landing page moved off the app
// origin entirely, to bracemark-site on the apex (docs/hosting.md), so
// bracemark-web's `/` is now an unconditional router (components/home-redirect.tsx)
// — a component that renders nothing in EVERY state, because there is no content
// on that origin's root to gate. Same route, different job; hence the different
// name. The shape to compare this one to is GuestGuard's — and it is a GUARD,
// not a Gate, for the reason that splits the two families here: a guard's
// non-pass branch NAVIGATES, while a Gate (AppLockGate, InitialSyncGate) swaps
// content in place and never leaves the route. A native app has no apex to send
// anyone to — its landing screen has to live in the binary — so
// `src/app/index.tsx` keeps rendering a real hero and this stays.
//
// It NAVIGATES on 'authenticated' ALONE, which is also what makes it safe during
// a sign-out with no clause of its own: 'ending' — the teardown frame the other
// two guards test for explicitly — renders null alongside 'loading'. Keep it that
// way. Rewriting this as "if not authenticated, show the landing" would render
// the hero from a teardown frame, and "if not authenticated, redirect somewhere"
// would route from one, which is the one thing nothing under the auth gate may
// do (docs/data-lifecycle.md, "the sign-out teardown").
//
// No ?next= here: the root is never a return target, so /links is the only
// destination. Uses expo-router's declarative <Redirect> (navigate-on-mount) in
// place of web's render-phase redirect() throw.
export function HomeGuard({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'authenticated') return <Redirect href="/links" />;
  // 'loading' | 'ending' — nothing to show and nothing to decide from.
  if (status !== 'unauthenticated') return null;
  return children;
}
