// Specs for the auth-aware fetch every web app's api client is built on. Its two jobs
// pull against each other, and getting either wrong is silent:
//
//   - ATTACH the bearer token, but only when there is a usable one. `getToken` withholds
//     an expired token while `getSession` still holds the record (session-store.ts), and
//     that gap is precisely the mid-session expiry this wrapper has to notice — without a
//     round trip, since the request would only earn a 401.
//   - INVALIDATE on a 401 — but only for a request it actually AUTHENTICATED. A 401 on an
//     unauthenticated call is the endpoint's own business: a wrong-password sign-in
//     answers 401, and treating that as "your session died" drops the user to signed-out
//     from the very screen they are signing in on, with a form that just seems to reset.
//
// Driven through a real `api.call` rather than by reaching for the wrapper directly, so a
// build that constructed the auth fetch but forgot to hand it to `createApiClient` fails
// here. `notifySessionInvalid` is real, not mocked: it is a pure fan-out over subscribers
// (session-store.ts), so subscribing IS the observation — and a mock would let the
// wrapper call something that no longer reaches the auth provider.

import {
  ApiError,
  dataDeleteAllEndpoint,
  iapStatusEndpoint,
  type SubscriptionStatus,
} from '@stxapps/shared';

import { clearSession, onSessionInvalid, saveSession } from '../data/session-store';
import { createAuthApiClient } from './auth-api-client';

const BASE_URL = 'https://api.example.test';
const HOUR = 60 * 60 * 1000;

const FREE: SubscriptionStatus = {
  plan: 'free',
  status: 'none',
  source: null,
  expiresAt: null,
  willRenew: false,
};

let fetchMock: jest.Mock;
let invalidated: jest.Mock;
let unsubscribe: () => void;

beforeEach(async () => {
  await clearSession();
  fetchMock = jest.fn(async () => Response.json(FREE));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  invalidated = jest.fn();
  unsubscribe = onSessionInvalid(invalidated);
});

afterEach(() => {
  unsubscribe();
});

async function signIn(expiresAt: number): Promise<void> {
  await saveSession({
    username: 'alice',
    token: 'tok_live',
    expiresAt,
    encryptionKey: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
  });
}

// One authenticated read through the real client. Swallows the ApiError a non-2xx
// stub produces — the subject here is what went out and what the store was told, not
// how the caller handles the failure.
async function callStatus(): Promise<void> {
  const api = createAuthApiClient({ baseUrl: BASE_URL });
  await api.call(iapStatusEndpoint, {}).catch((err: unknown) => {
    if (!(err instanceof ApiError)) throw err;
  });
}

const sentAuthHeader = (): string | null =>
  new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers).get(
    'authorization',
  );

describe('the auth-aware fetch', () => {
  it('sends no authorization header while signed out', async () => {
    await callStatus();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentAuthHeader()).toBeNull();
  });

  it('attaches the bearer token of a live session', async () => {
    await signIn(Date.now() + HOUR);

    await callStatus();

    expect(sentAuthHeader()).toBe('Bearer tok_live');
  });

  // The gap `getToken` opens on purpose: no usable token, but a session record still on
  // the device. That combination can only mean the token expired mid-session, and the
  // loop closes here rather than after a round trip that could only 401.
  it('notices a token that expired mid-session, without sending it', async () => {
    await signIn(Date.now() - 1);

    await callStatus();

    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(sentAuthHeader()).toBeNull();
  });

  // Signed out is not "expired": there is no session record, so there is nothing to
  // invalidate. Firing here would sign the user out on every public request the app makes
  // — the username check on the create-account screen, for one.
  it('does not invalidate when there is no session at all', async () => {
    await callStatus();

    expect(invalidated).not.toHaveBeenCalled();
  });

  it('invalidates when the server rejects a token it sent', async () => {
    await signIn(Date.now() + HOUR);
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));

    await callStatus();

    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  // THE ASYMMETRY THAT MATTERS: a 401 on a request we never authenticated. Only reachable
  // while signed out, which is exactly when a wrong-password sign-in happens.
  it('does not invalidate on a 401 for a request it never authenticated', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));

    await callStatus();

    expect(invalidated).not.toHaveBeenCalled();
  });

  // Every other failure says nothing about whether this session is alive. Signing out
  // over one would turn a transient server error into a re-derivation of the user's key.
  it.each([403, 404, 429, 500])('leaves the session alone on a %i', async (status) => {
    await signIn(Date.now() + HOUR);
    fetchMock.mockResolvedValue(new Response('{}', { status }));

    await callStatus();

    expect(invalidated).not.toHaveBeenCalled();
  });

  // The caller's own init must survive the header being added — a wrapper that replaced
  // `init` rather than spreading it would strip the content-type and the body off every
  // POST, and the failure would surface as a server-side parse error, not as anything
  // pointing back here.
  it('preserves the caller’s method, body and headers alongside the token', async () => {
    await signIn(Date.now() + HOUR);
    const api = createAuthApiClient({ baseUrl: BASE_URL });
    fetchMock.mockResolvedValue(Response.json({ deletedCount: 0 }));

    await api.call(dataDeleteAllEndpoint, {});

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(sentAuthHeader()).toBe('Bearer tok_live');
  });
});
