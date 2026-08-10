import { createApiClient } from '@stxapps/shared';

import { getSession, getToken, notifySessionInvalid } from '../data/session-store';

// The expo binding of the typed API client to bracemark-api — the `platform:expo`
// sibling of web-react's `createAuthApiClient`. Same shape and same auth-fetch
// contract; the only differences are that it reads the expo session-store (raw
// bytes in secure-store, not IndexedDB) and runs on React Native's global
// `fetch`/`Headers` instead of the browser's. The base URL genuinely can't live
// here — the app resolves it from its own bundler-inlined env var
// (`EXPO_PUBLIC_API_URL`, Metro-inlined at build time, the RN analogue of Next's
// `NEXT_PUBLIC_API_URL` / wxt's `WXT_PUBLIC_API_URL`), which the layering rules
// keep out of packages. So the app passes the resolved `baseUrl` in; everything
// else — the auth-aware fetch and the client wiring — lives here once.
export function createAuthApiClient({ baseUrl }: { baseUrl: string }) {
  // Attach the bearer token (when there's a live session) so protected endpoints
  // authenticate. Reads the in-memory session synchronously — the auth provider
  // hydrates it from secure-store on load — so there's no per-request keychain hit.
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
