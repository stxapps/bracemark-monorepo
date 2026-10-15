// Specs for the bearer token each client sends. The plain client reads the module
// session per request — right for the app, where one lifecycle owner changes it.
// A bound client sends the token of the one record it was bound to, whatever the
// module session becomes: the iOS share extension's upload binds the record its
// owner check passed (share-store.ts, uploadQueuedDraft), because in that process
// a second share can load another account's session between the first upload's
// requests. The second spec is that case, request by request.

import { defineEndpoint, SESSION_ERROR, z } from '@stxapps/shared';

import { getSession, notifySessionVerdict, type SessionRecord } from '../data/session-store';
import { createAuthApiClient } from './auth-api-client';

jest.mock('../data/session-store', () => ({
  getSession: jest.fn(() => null),
  notifySessionVerdict: jest.fn(),
}));

const pingEndpoint = defineEndpoint({
  method: 'POST',
  path: '/v1/test/ping',
  request: z.object({}),
  response: z.object({ ok: z.literal(true) }),
});

function record(username: string): SessionRecord {
  return {
    username,
    token: `token-${username}`,
    encryptionKey: new Uint8Array(32),
    state: 'active',
    generation: `generation-${username}`,
  };
}

let fetchMock: jest.Mock;
const currentSession = getSession as jest.Mock;
const verdicts = notifySessionVerdict as jest.Mock;

function sentTokens(): (string | null)[] {
  return fetchMock.mock.calls.map(([, init]) =>
    new Headers((init as RequestInit | undefined)?.headers).get('authorization'),
  );
}

beforeEach(() => {
  fetchMock = jest.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  currentSession.mockReset().mockReturnValue(null);
  verdicts.mockClear();
});

const api = createAuthApiClient({ baseUrl: 'https://api.test' });

it('the plain client sends the module session’s token at the time of each request', async () => {
  currentSession.mockReturnValue(record('alice'));
  await api.call(pingEndpoint, {});
  currentSession.mockReturnValue(record('bob'));
  await api.call(pingEndpoint, {});
  currentSession.mockReturnValue(null);
  await api.call(pingEndpoint, {});

  expect(sentTokens()).toEqual(['Bearer token-alice', 'Bearer token-bob', null]);
});

it('a bound client keeps sending its own record’s token after the module session changes', async () => {
  currentSession.mockReturnValue(record('alice'));
  const bound = api.bindSession(record('alice'));
  await bound.call(pingEndpoint, {});
  // A second share in the same extension process loaded bob's mirrored session.
  currentSession.mockReturnValue(record('bob'));
  await bound.call(pingEndpoint, {});
  // And a sign-out in between leaves nothing in the module at all.
  currentSession.mockReturnValue(null);
  await bound.call(pingEndpoint, {});

  expect(sentTokens()).toEqual(['Bearer token-alice', 'Bearer token-alice', 'Bearer token-alice']);
});

it('a bound client reports a session verdict under its own record’s generation', async () => {
  currentSession.mockReturnValue(record('bob'));
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ error: SESSION_ERROR.expired }), { status: 401 }),
  );

  await expect(api.bindSession(record('alice')).call(pingEndpoint, {})).rejects.toThrow();

  expect(verdicts).toHaveBeenCalledWith(
    expect.objectContaining({ generation: 'generation-alice' }),
  );
});
