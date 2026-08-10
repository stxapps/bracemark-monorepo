import { HomeRedirect } from '../components/home-redirect';

// `/` on app.bracemark.com routes and renders nothing else — see HomeRedirect. The
// public landing page this route used to hold moved to the apex when bracemark-site
// was added (docs/hosting.md).
export default function Page() {
  return <HomeRedirect />;
}
