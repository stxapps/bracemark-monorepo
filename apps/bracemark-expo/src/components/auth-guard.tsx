import { type ReactNode } from 'react';
import { Redirect, usePathname } from 'expo-router';

import { useAuth } from '@stxapps/expo-react';

// Client-side gate for the signed-in app group — the expo sibling of bracemark-web's
// components/auth-guard.tsx. Auth is client-only: the bearer token and raw
// `encryptionKey` bytes live in secure-store (session-store), never in a cookie,
// so there's no server to gate — the check runs here off `useAuth`.
//
// 'loading' (AuthProvider still hydrating from secure-store) renders nothing, so
// an authed cold start doesn't flash the signed-out UI before the session reads
// back. 'unauthenticated' returns expo-router's declarative `<Redirect>` instead
// of web's render-phase `redirect()` throw — same effect (the protected subtree
// never mounts), just the RN idiom: it navigates on mount and renders null.
//
// Where a non-authenticated user goes depends on WHY they're here (auth `reason`):
// a deliberate 'signed-out' goes home to '/', since offering to return them to the
// screen they just left would be silly. Everything else — an 'expired' session or
// a direct/deep-link visit (reason null) — goes to /sign-in with the intended path
// stashed in `?next=`, so sign-in can return them there instead of always /links
// (GuestGuard reads the param).
//
// Divergence from web: `next` carries the pathname only, not `?query`. Web
// preserves the query because it holds filter/search state in the URL;
// expo-router merges route + query params into one bag (no clean "just the query"
// read) and the protected mobile routes carry no query state yet — so pathname is
// the faithful, contamination-free capture. Revisit if a protected route ever
// puts real state in the URL.
export function AuthGuard({ children }: { children: ReactNode }) {
  const { status, reason } = useAuth();
  const pathname = usePathname();

  if (status === 'loading') return null;
  if (status === 'unauthenticated') {
    if (reason === 'signed-out') return <Redirect href="/" />;
    return <Redirect href={`/sign-in?next=${encodeURIComponent(pathname)}`} />;
  }

  return children;
}
