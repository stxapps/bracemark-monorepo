import { createApiClient, sessionVerdictFromResponse } from '@stxapps/shared';

import { getSession, notifySessionVerdict } from '../data/session-store';

// The shared binding of the typed API client to bracemark-api, used by every web app
// (bracemark-web, bracemark-extension, and the future docs site). The only thing that
// differs per app is the base URL — and that genuinely can't live here: each app
// resolves it from its own bundler-inlined env var (`NEXT_PUBLIC_API_URL` for
// Next, `WXT_PUBLIC_API_URL` for wxt), which the layering rules keep out of
// packages. So the app passes the resolved `baseUrl` in; everything else — the
// auth-aware fetch and the client wiring — lives here once.
export function createAuthApiClient({ baseUrl }: { baseUrl: string }) {
  // Attach the bearer token (when there's a session) so protected endpoints
  // authenticate. Reads the in-memory session synchronously — the auth provider
  // hydrates it from IndexedDB on load — so there's no per-request IndexedDB hit.
  // Public endpoints (username check, create-account, sign-in) simply ignore it.
  //
  // Also reports the server's verdict on the token it sent — and ONLY a verdict
  // (docs/sessions.md, _only our own code counts_):
  //   - the session CODES decide, never the status. A proxy's HTML 401, a
  //     gateway's error page, a codeless 401 or a body that won't parse is just a
  //     failed request, handled like a network error — the cycle fails and
  //     retries. A bare `status === 401` check is exactly what's forbidden here.
  //   - only for a request it AUTHENTICATED. A 401 on an unauthenticated call is
  //     the endpoint's own business (a wrong-password sign-in answers 401
  //     `invalid_credentials`).
  //   - tagged with the GENERATION captured when the request left, not whatever
  //     is current when it lands: a slow answer for a token that has since been
  //     replaced must not expire or erase its replacement. The provider compares.
  // It signals; it never mutates session state. There's no clock here either:
  // an old session is sent as it is, and the server says what it is.
  const authFetch: typeof fetch = async (input, init) => {
    const session = getSession();
    if (!session) return fetch(input, init);

    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${session.token}`);
    const res = await fetch(input, { ...init, headers });
    if (res.status === 401) {
      // A clone, so the caller still gets to read the body it's owed.
      const body = await res
        .clone()
        .text()
        .catch(() => '');
      const verdict = sessionVerdictFromResponse(res.status, body);
      if (verdict) notifySessionVerdict({ verdict, generation: session.generation });
    }
    return res;
  };

  return createApiClient({ baseUrl, fetch: authFetch });
}
