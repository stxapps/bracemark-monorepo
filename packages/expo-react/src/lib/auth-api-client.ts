import { type ApiClient, createApiClient, sessionVerdictFromResponse } from '@stxapps/shared';

import { getSession, notifySessionVerdict, type SessionRecord } from '../data/session-store';

// The api client this package's createAuthApiClient returns: the ordinary
// client, plus a way to pin one session's token for a run of requests.
export interface AuthApiClient extends ApiClient {
  // A client that sends THIS record's token on every request, whatever the
  // module session (getSession) becomes in the meantime. For a caller that has
  // checked a session and then does several requests with that session's key:
  // the iOS share extension's upload (share-store.ts, uploadQueuedDraft), where a
  // second share saved in the same process can load another account's session
  // between the first upload's requests. Read per request, the rest of the first
  // upload would go out under the second account's token with blobs sealed under
  // the first's key.
  bindSession(session: SessionRecord): ApiClient;
}

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
export function createAuthApiClient({ baseUrl }: { baseUrl: string }): AuthApiClient {
  const client = createApiClient({ baseUrl, fetch: authFetch(getSession) });
  return {
    call: client.call,
    bindSession: (session) => createApiClient({ baseUrl, fetch: authFetch(() => session) }),
  };
}

// Attach the bearer token (when there's a session) so protected endpoints
// authenticate. `readSession` is getSession for the ordinary client — the
// in-memory session, read synchronously per request (the auth provider hydrates
// it from secure-store on load), so there's no per-request keychain hit — and a
// fixed record for a bound one. Public endpoints (username check, create-account,
// sign-in) simply ignore the header.
//
// Also reports the server's verdict on the token it sent — and ONLY a verdict
// (docs/sessions.md, _only our own code counts_): our session CODES decide,
// never a bare status, so a proxy's HTML 401 or a codeless 401 is just a failed
// request; only for a request it AUTHENTICATED; and tagged with the GENERATION
// captured when the request left, so a slow answer for a replaced token can't
// touch its replacement. No clock: the session is sent as it is.
//
// The iOS share extension builds this same client, and a verdict fired there
// reaches no listener — it runs no AuthProvider, and never acts on a 401.
function authFetch(readSession: () => SessionRecord | null): typeof fetch {
  return async (input, init) => {
    const session = readSession();
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
}
