import { Redirect, Unmatched, usePathname } from 'expo-router';

// The catch-all for paths that match no route — reachable mainly through the
// public custom scheme (`bracemark://…` in app.config.ts, which any web page
// or app can fire), and in development through a mistyped `router.push`.
//
// It sits at the ROOT of `src/app/`, a sibling of `(app)` and `(auth)`, so it
// renders outside both AuthGuard and GuestGuard: an unmatched path is not an
// authentication question, and a guard here would bounce the user before this
// screen could decide anything. `+not-found` is one of expo-router's special
// names (alongside `_layout`, `(group)`, `+native-intent`, …), so it adds no
// route segment of its own.
//
// In production it redirects to `/`, which already sorts out both cases —
// AuthedHomeRedirect (src/app/index.tsx) bounces an authenticated user on to
// `/links`, guests get the landing. Deliberately no UI of its own: expo-router's
// built-in fallback (`views/Unmatched`) is dev-shaped — its main link navigates
// to the same broken path, and with the root Stack's `headerShown: false` it
// arrives with no header, no title, and nothing but its own "Go back" text,
// which is a poor landing for someone who followed a stale link.
//
// In development that fallback is exactly what you want, so keep it: it names
// the path that missed and links to `/_sitemap`. `__DEV__` is a build-time
// constant, so the production bundle keeps only the redirect. The console line
// is the part a silent redirect would otherwise cost you — without it, a typo'd
// push just lands on the landing page with no explanation.
export default function NotFound() {
  const pathname = usePathname();

  if (__DEV__) {
    console.warn(`[router] no route matched: ${pathname}`);
    return <Unmatched />;
  }

  return <Redirect href="/" />;
}
