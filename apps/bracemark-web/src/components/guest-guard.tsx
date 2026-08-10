'use client';

import { type ReactNode, Suspense } from 'react';
import { redirect, useSearchParams } from 'next/navigation';

import { useAuth } from '@stxapps/web-react';

// Where to send an authenticated visitor: honor a `?next=` set by AuthGuard, but
// only ever to an in-app path. Anything that isn't a plain relative path (absolute
// URLs, protocol-relative `//evil.com`, `/\evil.com`) is rejected to '/links' so a
// crafted link can't turn sign-in into an open redirect.
function safeNext(next: string | null): string {
  if (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')) {
    return next;
  }
  return '/links';
}

// Mirror of AuthGuard for the guest-only auth routes (/sign-in, /create-account):
// an authenticated visitor has no business here, so bounce them to the app. This
// is what redirects after account creation / sign-in — onSuccess just calls
// setSession, status flips to 'authenticated', this re-renders and redirects — so
// the navigation lives in the routing layer, not the mutation. It also covers an
// already-signed-in user landing on an auth URL directly.
//
// 'loading' (AuthProvider still hydrating) renders nothing, so we don't flash the
// sign-in form at someone who's about to be bounced. Render-phase redirect()
// throws to unmount before commit (defaults to replace outside Server Actions).
//
// useSearchParams() opts this subtree out of static prerendering, so it must sit
// under a Suspense boundary (see AuthGuard); the null fallback matches the
// 'loading' render so the sign-in form never flashes before params resolve.
function InnerGuestGuard({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const next = useSearchParams().get('next');

  if (status === 'loading') return null;
  if (status === 'authenticated') redirect(safeNext(next));

  return children;
}

export function GuestGuard({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <InnerGuestGuard>{children}</InnerGuestGuard>
    </Suspense>
  );
}
