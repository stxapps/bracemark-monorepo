import { HomeGuard } from '../components/home-guard';
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
// HomeGuard decides which audience this route is for, off the AuthProvider in the
// root `_layout`: the hero for a guest, a bounce to /links for an authenticated
// visitor, and nothing at all until the session has read back — this is the
// launch route, so an ungated hero would flash at every signed-in cold start.
export default function Index() {
  return (
    <HomeGuard>
      <Landing />
    </HomeGuard>
  );
}
