'use client';

import { type ReactNode, Suspense } from 'react';
import { redirect, usePathname, useSearchParams } from 'next/navigation';

import { useAuth } from '@stxapps/web-react';

import { SITE_URL } from '@/lib/site';

// Client-side gate for the signed-in app. Auth is client-only — the bearer token
// and non-extractable encryptionKey live in IndexedDB (see session-store), never
// in a cookie — so the server (server components, middleware) can't see the
// session and can't gate. The gate therefore runs here, off `useAuth`.
//
// 'loading' (AuthProvider still hydrating) renders nothing, so an authed reload
// doesn't flash the signed-out UI before the session is read back. 'unauthenticated'
// redirects during render via next/navigation `redirect()` — which throws to unmount
// the subtree before it commits (outside Server Actions it defaults to replace, the
// history semantics we want). Redirecting in render rather than an effect means
// protected content never paints for a signed-out user, with no intermediate null
// frame or effect round-trip.
//
// Where we send a non-authenticated user depends on WHY they're here (auth `reason`):
// a deliberate 'signed-out' leaves this origin entirely for the marketing site's
// landing page (the apex — SITE_URL), since offering to return them to the page they
// just left would be silly, and app.bracemark.com has no public page of its own to
// land on. This is the sign-out destination for every call site — the links topbar
// menu, the lock pane, Settings → Account — plus account deletion, which ends the
// session with the same default reason. redirect() takes the absolute URL: the client
// router sees a cross-origin href and turns it into a real location.replace().
//
// EXCEPT when we're running as an INSTALLED app (isInstalled below), where that same
// absolute URL is the bug. manifest.json declares no `scope`, so scope derives from
// `start_url: "."` — i.e. `/` on THIS origin — and the apex sits outside it. A
// standalone window navigating out of scope doesn't navigate: the platform hands the
// document to its in-app browser (an iOS overlay, an Android Custom Tab) and strands
// the user there, outside the app window. Bouncing site → app can't undo it either —
// the first navigation is what costs the window, and nothing on the site side can put
// the user back in it. So an installed sign-out stays on this origin, at /sign-in.
//
// Everything else — an 'expired' session or a
// direct visit (reason null) — bounces to /sign-in with the full intended path
// (including any query string) stashed in `?next=`, so sign-in can return them there
// instead of dumping everyone on /links (GuestGuard reads the param). The installed
// sign-out above carries no `?next=`: a deliberate sign-out has no intended path to
// come back to, which is the whole reason the browser-tab case leaves for the apex.
//
// useSearchParams() opts this subtree out of static prerendering, so Next requires
// it under a Suspense boundary; the inner component holds the hook and AuthGuard
// supplies the boundary. The null fallback matches the 'loading' render below, so
// the gate shows nothing (never a signed-out flash) until the params resolve.
// Running as an installed app (home-screen or desktop install) rather than in a
// browser tab. Asking for `display-mode: browser` and negating it covers standalone,
// minimal-ui, fullscreen and window-controls-overlay in one query: manifest.json asks
// for `standalone`, but the platform picks the mode it gives us, and every non-browser
// one has the same out-of-scope problem. `navigator.standalone` is the pre-display-mode
// iOS home-screen flag, kept for the Safari versions whose media query wasn't reliable.
//
// The `typeof window` guard is because bracemark-web is `output: 'export'`, so this
// file prerenders at build time. That prerender never reaches the call today — status
// starts 'loading' and the gate returns null above — but that's AuthProvider's
// invariant to keep, not this file's, and one clause makes this one safe on its own.
function isInstalled() {
  if (typeof window === 'undefined') return false;
  return (
    !window.matchMedia('(display-mode: browser)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function InnerAuthGuard({ children }: { children: ReactNode }) {
  const { status, reason } = useAuth();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (status === 'loading') return null;
  if (status === 'unauthenticated') {
    if (reason === 'signed-out') redirect(isInstalled() ? '/sign-in' : SITE_URL);
    const query = searchParams.toString();
    const next = query ? `${pathname}?${query}` : pathname;
    redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  }

  return children;
}

export function AuthGuard({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <InnerAuthGuard>{children}</InnerAuthGuard>
    </Suspense>
  );
}
