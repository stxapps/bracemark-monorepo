import { AuthedHomeRedirect } from '../components/authed-home-redirect';
import { Landing } from '../components/landing';

// The public landing at `/`, outside both `(app)` and `(auth)` groups. Thin route:
// the presentational UI lives in `src/components/landing.tsx` (so its spec can
// colocate — files under the app root become routes), while navigation concerns
// stay here.
//
// The web analogue is now bracemark-site's `src/app/page.tsx`, on the marketing apex
// — NOT bracemark-web's `/`, which is a bare redirect (docs/hosting.md). A native
// app can't hand off to a website for its first screen, so this landing ships in the
// binary and the two hero copies are maintained in parallel.
//
// AuthedHomeRedirect bounces already-authenticated visitors from `/` to `/links` off
// the AuthProvider in the root `_layout`; it renders null for guests, so the landing
// hero shows unaffected.
export default function Index() {
  return (
    <>
      <AuthedHomeRedirect />
      <Landing />
    </>
  );
}
