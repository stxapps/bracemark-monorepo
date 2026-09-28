// Specs for the auth-aware fetch every web app's api client is built on. It attaches
// the bearer token and REPORTS the server's verdict on it — and the rule it carries
// (docs/sessions.md) is silent when broken, so it's pinned here as a table:
//
//   - only OUR session codes are verdicts. A codeless 401, an HTML 401 from a proxy,
//     any other status, a network error — each is just a failed request. The fetch this
//     replaced invalidated on `status === 401`, which let anything between the device
//     and the api (or whoever holds the domain later) erase a user's library.
//   - only for a request it AUTHENTICATED: a wrong-password sign-in answers 401 too.
//   - tagged with the generation that SENT the request, so the provider can ignore a
//     verdict on a token that has since been replaced.
//   - no clock: a session is sent however old it is.
//
// Driven through a real `api.call` rather than by reaching for the wrapper directly, so a
// build that constructed the auth fetch but forgot to hand it to `createApiClient` fails
// here. `notifySessionVerdict` is real, not mocked: subscribing IS the observation.

import {
  ApiError,
  dataDeleteAllEndpoint,
  iapStatusEndpoint,
  SESSION_ERROR,
  type SubscriptionStatus,
} from '@stxapps/shared';

import {
  clearSession,
  onSessionVerdict,
  saveSession,
  type SessionRecord,
} from '../data/session-store';
import { createAuthApiClient } from './auth-api-client';

const BASE_URL = 'https://api.example.test';
const YEAR = 365 * 24 * 60 * 60 * 1000;

const FREE: SubscriptionStatus = {
  plan: 'free',
  status: 'none',
  source: null,
  expiresAt: null,
  willRenew: false,
};

let fetchMock: jest.Mock;
let verdicts: jest.Mock;
let unsubscribe: () => void;

beforeEach(async () => {
  await clearSession();
  fetchMock = jest.fn(async () => Response.json(FREE));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  verdicts = jest.fn();
  unsubscribe = onSessionVerdict(verdicts);
});

afterEach(() => {
  unsubscribe();
  jest.restoreAllMocks();
});

async function signIn(patch: Partial<SessionRecord> = {}): Promise<void> {
  await saveSession({
    username: 'alice',
    token: 'tok_live',
    encryptionKey: await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
    state: 'active',
    generation: 'gen-1',
    ...patch,
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

const envelope = (error: string) => Response.json({ error }, { status: 401 });

describe('the auth-aware fetch', () => {
  it('sends no authorization header while signed out', async () => {
    await callStatus();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentAuthHeader()).toBeNull();
  });

  it('attaches the bearer token of the session', async () => {
    await signIn();

    await callStatus();

    expect(sentAuthHeader()).toBe('Bearer tok_live');
  });

  // No clock: whatever time the device thinks it is, the token goes out and the server
  // answers for it.
  it('sends the token of a session signed in long ago, and reports nothing on success', async () => {
    await signIn();
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * YEAR);

    await callStatus();

    expect(sentAuthHeader()).toBe('Bearer tok_live');
    expect(verdicts).not.toHaveBeenCalled();
  });

  // The probe rides this: an expired session still sends its token.
  it('sends the token of an expired session', async () => {
    await signIn({ state: 'expired' });

    await callStatus();

    expect(sentAuthHeader()).toBe('Bearer tok_live');
  });

  describe('the rule, as a table', () => {
    it.each([
      [SESSION_ERROR.revoked, 'revoked'],
      [SESSION_ERROR.expired, 'expired'],
      [SESSION_ERROR.unknown, 'expired'],
    ])('reports our %s envelope as %s, for the generation that sent it', async (code, verdict) => {
      await signIn({ generation: 'gen-sent' });
      fetchMock.mockResolvedValue(envelope(code));

      await callStatus();

      expect(verdicts).toHaveBeenCalledTimes(1);
      expect(verdicts).toHaveBeenCalledWith({ verdict, generation: 'gen-sent' });
    });

    it.each([
      ['a codeless 401', () => new Response('', { status: 401 })],
      ['an empty-object 401', () => new Response('{}', { status: 401 })],
      [
        'an HTML 401 from something that is not us',
        () =>
          new Response('<html><body><h1>401 Authorization Required</h1></body></html>', {
            status: 401,
            headers: { 'content-type': 'text/html' },
          }),
      ],
      ['our envelope with another code', () => envelope('unauthorized')],
      [
        'session_revoked on a 403',
        () => Response.json({ error: 'session_revoked' }, { status: 403 }),
      ],
      ['a 500', () => new Response('{}', { status: 500 })],
      ['a 429', () => new Response('{}', { status: 429 })],
    ])('reports nothing for %s', async (_name, response) => {
      await signIn();
      fetchMock.mockResolvedValue(response());

      await callStatus();

      expect(verdicts).not.toHaveBeenCalled();
    });

    it('reports nothing for a network error', async () => {
      await signIn();
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

      const api = createAuthApiClient({ baseUrl: BASE_URL });
      await expect(api.call(iapStatusEndpoint, {})).rejects.toThrow('Failed to fetch');

      expect(verdicts).not.toHaveBeenCalled();
    });
  });

  // A delayed answer belongs to the session that SENT the request: if the token is
  // replaced (a resume) while the request is in flight, the verdict still names the old
  // generation, and the provider ignores it.
  it('tags a verdict with the generation captured at send, not the one current at arrival', async () => {
    await signIn({ generation: 'gen-old' });
    let answer!: (res: Response) => void;
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );

    const call = callStatus();
    await Promise.resolve();
    await signIn({ token: 'tok_new', generation: 'gen-new' });
    answer(envelope(SESSION_ERROR.revoked));
    await call;

    expect(verdicts).toHaveBeenCalledWith({ verdict: 'revoked', generation: 'gen-old' });
  });

  // A 401 on a request we never authenticated is the endpoint's own business — a
  // wrong-password sign-in, while signed out.
  it('reports nothing on a 401 for a request it never authenticated', async () => {
    fetchMock.mockResolvedValue(envelope(SESSION_ERROR.revoked));

    await callStatus();

    expect(verdicts).not.toHaveBeenCalled();
  });

  // The caller still reads the body it's owed — the verdict is read off a clone.
  it('leaves the response body for the caller', async () => {
    await signIn();
    fetchMock.mockResolvedValue(envelope(SESSION_ERROR.expired));

    const api = createAuthApiClient({ baseUrl: BASE_URL });
    const err = await api.call(iapStatusEndpoint, {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body).toContain(SESSION_ERROR.expired);
  });

  // The caller's own init must survive the header being added — a wrapper that replaced
  // `init` rather than spreading it would strip the content-type and the body off every
  // POST.
  it('preserves the caller’s method, body and headers alongside the token', async () => {
    await signIn();
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
