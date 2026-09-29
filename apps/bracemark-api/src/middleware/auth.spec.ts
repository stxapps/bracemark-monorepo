import { env } from 'cloudflare:workers';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { SESSION_ERROR } from '@stxapps/shared';

import { sessionsRepo } from '../db/repositories/sessions';
import type { AppEnv } from '../lib/env';
import { errorHandler } from '../lib/errors';
import { hashToken, newId } from '../lib/ids';
import {
  expireOtherSessions,
  purgeSessions,
  revokeAllSessions,
  revokeOtherSessions,
  revokeSession,
  SESSION_IDLE_MS,
  SESSION_PURGE_MS,
  SESSION_SLIDE_MS,
} from '../services/session';
import { requireAuth } from './auth';

// The guard every protected route sits behind, and the session lifecycle it
// reads (docs/sessions.md). The route specs cover what a flow surfaces; this file
// covers the rows no flow can produce without waiting months — a session past
// its idle deadline, one due for renewal, one a year past revocation — plus the
// hash-not-token discipline: what the sessions db stores must not itself open a
// session, or a leak of that db is a leak of every live session.
//
// The four failure codes are the load-bearing part. Clients wipe their local
// copy on `session_revoked` and on nothing else, so a guard that answered a
// missing row or an expired one with it would be a timed delete of every
// library — and nothing but this table would notice.
const app = new Hono<AppEnv>()
  .onError(errorHandler)
  .get('/protected', requireAuth, (c) => c.json(c.get('session')));

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const repo = () => sessionsRepo(env.SESSIONS_DB);

// Insert a session row directly, so its expiry is ours to choose.
async function seedSession(opts: { expiresAt: number; userId?: string; accountDbId?: string }) {
  const token = `tok_${newId()}`;
  const id = newId();
  const tokenHash = await hashToken(token);
  await repo().insert({
    id,
    tokenHash,
    userId: opts.userId ?? 'u_guarded',
    accountDbId: opts.accountDbId ?? '1',
    expiresAt: opts.expiresAt,
  });
  return { token, id, tokenHash };
}

// A session renewed just now — well inside the slide window, so a request
// against it writes nothing.
const fresh = () => seedSession({ expiresAt: Date.now() + SESSION_IDLE_MS });

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function call(token: string) {
  const res = await app.request('/protected', bearer(token), env);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const row = (tokenHash: string) => repo().findByTokenHash(tokenHash);

describe('requireAuth', () => {
  it('resolves the session onto the context, shard included', async () => {
    const { token, id } = await fresh();

    const res = await app.request('/protected', bearer(token), env);

    expect(res.status).toBe(200);
    // accountDbId rides the session precisely so a protected handler routes to
    // the user's accounts shard without a directory read.
    await expect(res.json()).resolves.toEqual({ id, userId: 'u_guarded', accountDbId: '1' });
  });

  describe('the four failures, each with its own code', () => {
    it('answers a missing or non-bearer header `unauthorized`', async () => {
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

    it('answers a token that matches no row `session_unknown`', async () => {
      expect(await call('tok_never_issued')).toMatchObject({
        status: 401,
        body: { error: SESSION_ERROR.unknown },
      });
    });

    it('answers a revoked row `session_revoked`', async () => {
      const { token, id } = await fresh();
      await revokeSession(env, id);

      expect(await call(token)).toMatchObject({
        status: 401,
        body: { error: SESSION_ERROR.revoked },
      });
    });

    it('answers an unrevoked row past its deadline `session_expired`', async () => {
      const { token } = await seedSession({ expiresAt: Date.now() - 1000 });

      expect(await call(token)).toMatchObject({
        status: 401,
        body: { error: SESSION_ERROR.expired },
      });
    });

    // A revoked session that has ALSO idled out must still deliver the stronger
    // verdict — otherwise a lost phone that stays offline past its deadline could
    // never be made to forget.
    it('checks revocation before expiry', async () => {
      const { token, id } = await seedSession({ expiresAt: Date.now() - DAY_MS });
      await revokeSession(env, id);

      expect((await call(token)).body.error).toBe(SESSION_ERROR.revoked);
    });
  });

  it('accepts a session that has not expired yet', async () => {
    const { token } = await seedSession({ expiresAt: Date.now() + 1000 });

    expect((await call(token)).status).toBe(200);
  });

  // The row holds SHA-256(token) and the guard hashes what it is handed, so the
  // stored value is not a credential: presenting it must fail (it would only
  // match a row storing hash(hash(token))).
  it('refuses the stored token hash presented as a token', async () => {
    const { tokenHash } = await fresh();

    expect(await call(tokenHash)).toMatchObject({
      status: 401,
      body: { error: SESSION_ERROR.unknown },
    });
  });
});

describe('sliding expiry', () => {
  it('slides a session due for renewal to a full idle window', async () => {
    // Last renewed two days ago: the deadline sits two days short of now + idle.
    const { token, tokenHash } = await seedSession({
      expiresAt: Date.now() + SESSION_IDLE_MS - 2 * DAY_MS,
    });
    const before = Date.now();

    expect((await call(token)).status).toBe(200);

    const after = (await row(tokenHash))?.expiresAt;
    expect(after).toBeGreaterThanOrEqual(before + SESSION_IDLE_MS);
  });

  it('keeps a near-dead session alive when it is used', async () => {
    const { token, tokenHash } = await seedSession({ expiresAt: Date.now() + HOUR_MS });

    expect((await call(token)).status).toBe(200);

    expect((await row(tokenHash))?.expiresAt).toBeGreaterThan(
      Date.now() + SESSION_IDLE_MS - HOUR_MS,
    );
  });

  it('writes nothing within a day of the last renewal', async () => {
    const expiresAt = Date.now() + SESSION_IDLE_MS - SESSION_SLIDE_MS / 2;
    const { token, tokenHash } = await seedSession({ expiresAt });

    expect((await call(token)).status).toBe(200);

    expect((await row(tokenHash))?.expiresAt).toBe(expiresAt);
  });

  // The throttle is in the UPDATE's predicate, not the guard's read: requests
  // that all read the same stale deadline still produce one renewal.
  it('changes the row once however many renewals are attempted at once', async () => {
    const expiresAt = Date.now() + SESSION_IDLE_MS - 2 * DAY_MS;
    const { id } = await seedSession({ expiresAt });
    const now = Date.now();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repo().renew(id, now, SESSION_IDLE_MS, SESSION_SLIDE_MS, expiresAt),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('never revives a revoked session, even one racing its renewal', async () => {
    const expiresAt = Date.now() + SESSION_IDLE_MS - 2 * DAY_MS;
    const { id, tokenHash } = await seedSession({ expiresAt });
    await revokeSession(env, id);

    expect(await repo().renew(id, Date.now(), SESSION_IDLE_MS, SESSION_SLIDE_MS, expiresAt)).toBe(
      false,
    );
    expect((await row(tokenHash))?.expiresAt).toBe(expiresAt);
  });

  it('never revives an expired session', async () => {
    const expiresAt = Date.now() - 1;
    const { id, tokenHash } = await seedSession({ expiresAt });

    expect(await repo().renew(id, Date.now(), SESSION_IDLE_MS, SESSION_SLIDE_MS, expiresAt)).toBe(
      false,
    );
    expect((await row(tokenHash))?.expiresAt).toBe(expiresAt);
  });

  it('does not undo password-change expiry when an earlier request renews late', async () => {
    const requestStartedAt = Date.now() - 1000;
    const { id, tokenHash } = await seedSession({
      expiresAt: requestStartedAt + SESSION_IDLE_MS - 2 * DAY_MS,
    });
    // waitUntil can land after the password-change write. Its timestamp still
    // belongs to the request that authenticated BEFORE that write.
    const changedAt = requestStartedAt + 500;
    await repo().expireByUserIdExcept('u_guarded', 'password-change-caller', changedAt);

    expect(
      await repo().renew(
        id,
        requestStartedAt,
        SESSION_IDLE_MS,
        SESSION_SLIDE_MS,
        requestStartedAt + SESSION_IDLE_MS - 2 * DAY_MS,
      ),
    ).toBe(false);
    expect((await row(tokenHash))?.expiresAt).toBe(changedAt - 1);
  });

  // A failed renewal must not fail the request it rides on (already authorized),
  // and leaves the old deadline — a later request tries again.
  it('lets the request through and keeps the old deadline when renewal fails', async () => {
    const expiresAt = Date.now() + SESSION_IDLE_MS - 2 * DAY_MS;
    const { token, tokenHash } = await seedSession({ expiresAt });
    const failing = {
      ...env,
      SESSIONS_DB: new Proxy(env.SESSIONS_DB, {
        get(target, prop, receiver) {
          if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
          return (sql: string) => {
            if (sql.trimStart().startsWith('UPDATE')) throw new Error('D1 primary unavailable');
            return target.prepare(sql);
          };
        },
      }),
    };
    const noise = console.error;
    console.error = () => undefined;
    try {
      const res = await app.request('/protected', bearer(token), failing);
      expect(res.status).toBe(200);
    } finally {
      console.error = noise;
    }

    expect((await row(tokenHash))?.expiresAt).toBe(expiresAt);
  });
});

describe('revocation and expiry writes', () => {
  it('keeps the original revocation time on a retry', async () => {
    const { id, tokenHash } = await fresh();
    await revokeSession(env, id);
    const first = (await row(tokenHash))?.revokedAt;

    await new Promise((r) => setTimeout(r, 5));
    await revokeSession(env, id);

    expect((await row(tokenHash))?.revokedAt).toBe(first);
  });

  it('marks an already-expired session revoked', async () => {
    const { token, id } = await seedSession({ expiresAt: Date.now() - DAY_MS });

    await revokeSession(env, id);

    expect((await call(token)).body.error).toBe(SESSION_ERROR.revoked);
  });

  it('revokes every session of an account, and only that account', async () => {
    const mine = await seedSession({ expiresAt: Date.now() + DAY_MS, userId: 'u_all' });
    const mineExpired = await seedSession({ expiresAt: Date.now() - DAY_MS, userId: 'u_all' });
    const stranger = await seedSession({ expiresAt: Date.now() + DAY_MS, userId: 'u_other' });

    await revokeAllSessions(env, 'u_all');

    expect((await call(mine.token)).body.error).toBe(SESSION_ERROR.revoked);
    expect((await call(mineExpired.token)).body.error).toBe(SESSION_ERROR.revoked);
    expect((await call(stranger.token)).status).toBe(200);
  });

  it('revokes the other sessions and keeps the caller’s', async () => {
    const caller = await fresh();
    const other = await fresh();

    await revokeOtherSessions(env, { id: caller.id, userId: 'u_guarded' });

    expect((await call(other.token)).body.error).toBe(SESSION_ERROR.revoked);
    expect((await call(caller.token)).status).toBe(200);
  });

  // The password change: cut off, but NOT told to forget.
  it('expires the other sessions without revoking them, and never moves a deadline forward', async () => {
    const caller = await fresh();
    const other = await fresh();
    const longExpired = await seedSession({ expiresAt: Date.now() - 30 * DAY_MS });
    const revoked = await fresh();
    await revokeSession(env, revoked.id);

    await expireOtherSessions(env, { id: caller.id, userId: 'u_guarded' });

    expect((await call(other.token)).body.error).toBe(SESSION_ERROR.expired);
    expect((await row(other.tokenHash))?.revokedAt).toBeNull();
    // An already-older deadline stays where it was: MIN, never forward.
    expect((await row(longExpired.tokenHash))?.expiresAt).toBeLessThan(Date.now() - 29 * DAY_MS);
    // A revoked row keeps its stronger verdict.
    expect((await call(revoked.token)).body.error).toBe(SESSION_ERROR.revoked);
    expect((await call(caller.token)).status).toBe(200);
  });
});

describe('cleanup', () => {
  it('purges each kind of row on its own clock', async () => {
    const now = Date.now();
    const just = SESSION_PURGE_MS - DAY_MS;
    const past = SESSION_PURGE_MS + DAY_MS;

    // Unrevoked rows age from their deadline.
    const expiredLongAgo = await seedSession({ expiresAt: now - past });
    const expiredRecently = await seedSession({ expiresAt: now - just });
    // Revoked rows age from their revocation — however old their deadline.
    const revokedLongAgo = await seedSession({ expiresAt: now + DAY_MS });
    await repo().revokeById(revokedLongAgo.id, now - past);
    const revokedRecently = await seedSession({ expiresAt: now - past });
    await repo().revokeById(revokedRecently.id, now - just);

    const purged = await purgeSessions(env, now);

    expect(purged).toBe(2);
    expect(await row(expiredLongAgo.tokenHash)).toBeNull();
    expect(await row(revokedLongAgo.tokenHash)).toBeNull();
    expect(await row(expiredRecently.tokenHash)).not.toBeNull();
    // Still inside its retention: a device coming back is still told to forget.
    expect((await call(revokedRecently.token)).body.error).toBe(SESSION_ERROR.revoked);
  });

  // ⚠ No missing row is evidence of revocation: a purged token — revoked or not
  // — gets the non-destructive answer, so cleanup can never become a wipe.
  it('turns a purged token into `session_unknown`', async () => {
    const now = Date.now();
    const revoked = await seedSession({ expiresAt: now });
    await repo().revokeById(revoked.id, now - SESSION_PURGE_MS - DAY_MS);
    const expired = await seedSession({ expiresAt: now - SESSION_PURGE_MS - DAY_MS });

    await purgeSessions(env, now);

    expect((await call(revoked.token)).body.error).toBe(SESSION_ERROR.unknown);
    expect((await call(expired.token)).body.error).toBe(SESSION_ERROR.unknown);
  });
});
