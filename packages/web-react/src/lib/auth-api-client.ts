import { createApiClient } from '@stxapps/shared';

import { getSession, getToken, notifySessionInvalid } from '../data/session-store';

// The shared binding of the typed API client to bracemark-api, used by every web app
// (bracemark-web, bracemark-extension, and the future docs site). The only thing that
// differs per app is the base URL — and that genuinely can't live here: each app
// resolves it from its own bundler-inlined env var (`NEXT_PUBLIC_API_URL` for
// Next, `WXT_PUBLIC_API_URL` for wxt), which the layering rules keep out of
// packages. So the app passes the resolved `baseUrl` in; everything else — the
// auth-aware fetch and the client wiring — lives here once.
export function createAuthApiClient({ baseUrl }: { baseUrl: string }) {
  // Attach the bearer token (when there's a live session) so protected endpoints
  // authenticate. Reads the in-memory session synchronously — the auth provider
  // hydrates it from IndexedDB on load — so there's no per-request IndexedDB hit.
  // Public endpoints (username check, create-account, sign-in) simply ignore it.
  //
  // Also closes the mid-session expiry/revocation loop: if the server rejects an
  // attached token (401), or a request is made while we still hold a session whose
  // token has expired (getToken withholds it, getSession still has the record), we
  // fire notifySessionInvalid so the auth provider can drop to signed-out. We only
  // treat a token we actually sent as invalidating — a 401 on an unauthenticated
  // request (e.g. a wrong-password sign-in) is the endpoint's own business.
  const authFetch: typeof fetch = async (input, init) => {
    const token = getToken();
    if (!token) {
      // No usable token but a session record lingers ⇒ it expired mid-session.
      if (getSession()) notifySessionInvalid();
      return fetch(input, init);
    }

    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(input, { ...init, headers });
    if (res.status === 401) notifySessionInvalid();
    return res;
  };

  return createApiClient({ baseUrl, fetch: authFetch });
}
