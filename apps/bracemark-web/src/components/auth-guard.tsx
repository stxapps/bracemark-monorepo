'use client';

import { type ReactNode, Suspense, useEffect } from 'react';
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
// frame or effect round-trip. That holds for every SAME-ORIGIN destination here; the
// one cross-origin destination is the exception, and it is the next paragraph.
//
// Where we send a non-authenticated user depends on WHY they're here (auth `reason`):
// a deliberate 'signed-out' leaves this origin entirely for the marketing site's
// landing page (the apex — SITE_URL), since offering to return them to the page they
// just left would be silly, and app.bracemark.com has no public page of its own to
// land on. This is the sign-out destination for every call site — the links topbar
// menu, the lock pane, Settings → Account — plus account deletion, which ends the
// session with the same default reason.
//
// That one leaves by `location.replace` in an EFFECT, not by `redirect()`, and the
// difference is load-bearing. It is also the general rule for this app, written up
// once in hosting.md (_crossing an origin_) — same-origin goes through
// next/navigation, another origin goes through window.location, and this file is
// just its one live case. Handed a cross-origin href, redirect() routes through
// Next's MPA path, which is a side effect in render: `Router` calls location.replace
// and then THROWS mid-render, skipping every hook below the throw (app-router.tsx,
// "Don't try this at home, kids"). It stays thrown only while nothing dispatches to
// the router. Anything that does clears the flag, so the next Router render runs past
// the throw with MORE hooks than the aborted one — React fails the render with
// "Rendered more hooks than during the previous render", and that error takes the
// pending navigation down with it, leaving the user signed out on the page they were
// trying to leave.
//
// Sign-out used to dispatch exactly such a navigation, and this is the ONE gate that
// has to know why it no longer does. The teardown now runs in two steps
// (auth-provider's endSession): 'ending' first, which closes this gate and unmounts
// the whole app subtree, and only then the wipe and the flip to 'unauthenticated'.
// So by the time we leave, no descendant is mounted to route: whatever the links page
// would have made of a wiped store — reading the `?list=`/`?tag=` it is on as a
// deleted entity and replacing the URL on its way out (page-provider's
// isStaleSelection) — never happens, because it isn't there to see it. That is what
// makes THIS component the sole navigator during a sign-out, and it's an invariant of
// the teardown, not of this file: any future effect under here that navigates on its
// own would be safe for the same reason, and unsafe again the moment the gate stops
// closing first. Doing our own navigation is the second half of the same defence —
// it keeps Router out of the MPA branch entirely, so even a stray late dispatch is
// just a dispatch. Keep both; each is cheap and they fail independently.
//
// The cost is one null frame before the browser leaves, which is why this is the
// exception and not the rule: it's a page we're abandoning, so there is nothing to
// flash — and no protected content renders in it either way.
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

  // The one destination off this origin (see the header). `replace`, matching the
  // history semantics of every other exit here — the app is not somewhere Back
  // should return to once the session is gone. Idempotent under a repeat commit
  // (dev's double-invoked effects, a re-render before unload): the second call
  // replaces the same URL.
  const leaving = status === 'unauthenticated' && reason === 'signed-out' && !isInstalled();
  useEffect(() => {
    if (leaving) window.location.replace(SITE_URL);
  }, [leaving]);

  // 'ending' rides with 'loading' on purpose (see the header): a sign-out is in
  // flight, so the subtree comes down NOW — before endSession's wipe empties the
  // store under it — while the exit navigation waits for the flip below.
  if (status === 'loading' || status === 'ending') return null;
  if (status === 'unauthenticated') {
    // Installed: stay on this origin (the scope trap in the header). In a browser
    // tab the effect above is already taking us to the apex — render nothing until
    // it lands, rather than falling through to the `?next=` bounce below.
    if (reason === 'signed-out') {
      if (isInstalled()) redirect('/sign-in');
      return null;
    }
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
