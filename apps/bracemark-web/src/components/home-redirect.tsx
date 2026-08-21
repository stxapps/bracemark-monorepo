'use client';

import { redirect } from 'next/navigation';

import { useAuth } from '@stxapps/web-react';

// `/` on THIS origin (app.bracemark.com) is not a page — it's a router. The public
// landing lives on the apex, in bracemark-site (docs/hosting.md), so nobody
// should ever look at app.bracemark.com/: an authenticated visitor wants /links, a
// signed-out one wants /sign-in.
//
// Client-side rather than a `redirect()` in next.config or a server component,
// because bracemark-web is a static export (`output: 'export'`) — there is no server
// to issue a 3xx, and the decision depends on a session that only exists in the
// browser. CloudFront could redirect `/` unconditionally, but not to the RIGHT one
// of the two: it can't see the session either.
//
// 'loading' (AuthProvider still hydrating) renders nothing, same as GuestGuard —
// there is nothing to show here in any state, so this component always returns null.
export function HomeRedirect() {
  const { status } = useAuth();

  // 'ending' rides with 'loading' (same rule as the two guards): a sign-out in
  // flight is not a state to route from — AuthGuard owns the exit — and routing on
  // it would send the user to /sign-in a beat before the real destination is known.
  if (status === 'loading' || status === 'ending') return null;
  redirect(status === 'authenticated' ? '/links' : '/sign-in');
}
