import { type ReactNode } from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';

import { useAuth } from '@stxapps/expo-react';

// Where to send an authenticated visitor: honor a `?next=` set by AuthGuard, but
// only ever to an in-app path. Anything that isn't a plain relative path (absolute
// URLs, protocol-relative `//evil.com`, `/\evil.com`) is rejected to '/links' so a
// crafted deep link can't turn sign-in into an open redirect. Identical to
// bracemark-web's guest-guard safeNext.
function safeNext(next: string | null): string {
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) {
    return next;
  }
  return '/links';
}

// Mirror of AuthGuard for the guest-only auth group (/sign-in, /create-account) —
// the expo sibling of bracemark-web's components/guest-guard.tsx. An authenticated
// visitor has no business here, so bounce them to the app. This is what redirects
// after account creation / sign-in: onSuccess calls setSession, status flips to
// 'authenticated', this re-renders and redirects — so the navigation lives in the
// routing layer, not the mutation. It also covers an already-signed-in user
// landing on an auth URL directly.
//
// 'loading' (AuthProvider still hydrating) renders nothing, so we don't flash the
// sign-in form at someone about to be bounced. Uses expo-router's declarative
// `<Redirect>` (navigate-on-mount, renders null) in place of web's render-phase
// `redirect()` throw; no Suspense boundary is needed (that was a Next.js
// static-prerender constraint, not an RN one).
export function GuestGuard({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const params = useLocalSearchParams<{ next?: string }>();
  const next = typeof params.next === 'string' ? params.next : null;

  if (status === 'loading') return null;
  if (status === 'authenticated') return <Redirect href={safeNext(next)} />;

  return children;
}
