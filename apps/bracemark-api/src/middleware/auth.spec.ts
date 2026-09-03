import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { sessionsRepo } from '../db/repositories/sessions';
import type { AppEnv } from '../lib/env';
import { errorHandler } from '../lib/errors';
import { hashToken, newId } from '../lib/ids';
import { requireAuth } from './auth';

// The guard every protected route sits behind. The route specs cover the two
// cases a flow surfaces (no token, unknown token); this file covers the two they
// can't reach — a session past its expiry, which no route can produce without
// waiting out the 30-day TTL, and the hash-not-token discipline: what the
// sessions db stores must not itself open a session, or a leak of that db is a
// leak of every live session.
const app = new Hono<AppEnv>()
  .onError(errorHandler)
  .get('/protected', requireAuth, (c) => c.json(c.get('session')));

// Insert a session row directly, so its expiry is ours to choose.
async function seedSession(opts: { expiresAt: number; userId?: string; accountDbId?: string }) {
  const token = `tok_${newId()}`;
  const id = newId();
  const tokenHash = await hashToken(token);
  await sessionsRepo(env.SESSIONS_DB).insert({
    id,
    tokenHash,
    userId: opts.userId ?? 'u_guarded',
    accountDbId: opts.accountDbId ?? '1',
    expiresAt: opts.expiresAt,
  });
  return { token, id, tokenHash };
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const HOUR_MS = 60 * 60 * 1000;

describe('requireAuth', () => {
  it('resolves the session onto the context, shard included', async () => {
    const { token, id } = await seedSession({ expiresAt: Date.now() + HOUR_MS });

    const res = await app.request('/protected', bearer(token), env);

    expect(res.status).toBe(200);
    // accountDbId rides the session precisely so a protected handler routes to
    // the user's accounts shard without a directory read.
    await expect(res.json()).resolves.toEqual({ id, userId: 'u_guarded', accountDbId: '1' });
  });

  it('rejects a session past its expiry', async () => {
    const { token } = await seedSession({ expiresAt: Date.now() - 1000 });

    const res = await app.request('/protected', bearer(token), env);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error: 'unauthorized',
      message: 'Invalid or expired session',
    });
  });

  it('accepts a session that has not expired yet', async () => {
    const { token } = await seedSession({ expiresAt: Date.now() + 1000 });

    expect((await app.request('/protected', bearer(token), env)).status).toBe(200);
  });

  // The row holds SHA-256(token) and the guard hashes what it is handed, so the
  // stored value is not a credential: presenting it must fail (it would only
  // match a row storing hash(hash(token))).
  it('refuses the stored token hash presented as a token', async () => {
    const { tokenHash } = await seedSession({ expiresAt: Date.now() + HOUR_MS });

    expect((await app.request('/protected', bearer(tokenHash), env)).status).toBe(401);
  });

  it('refuses an unknown token', async () => {
    expect((await app.request('/protected', bearer('tok_never_issued'), env)).status).toBe(401);
  });

  it('refuses a request whose Authorization header is missing or not a bearer token', async () => {
    const cases = [
      {},
      { headers: { authorization: '' } },
      { headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      { headers: { authorization: 'Bearer ' } },
      { headers: { authorization: 'Bearer    ' } },
    ];

    for (const init of cases) {
      const res = await app.request('/protected', init, env);
      expect(res.status).toBe(401);
      await expect(res.json()).resolves.toMatchObject({ error: 'unauthorized' });
    }
  });
});
