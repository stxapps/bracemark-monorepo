import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import { SESSION_ERROR } from '@stxapps/shared';

import { sessionsRepo } from '../db/repositories/sessions';
import type { AppEnv } from '../lib/env';
import { HttpError } from '../lib/errors';
import { hashToken } from '../lib/ids';
import { renewSession, SESSION_IDLE_MS, SESSION_SLIDE_MS } from '../services/session';

// Auth guard. Applied to protected routes (not globally), e.g.
// app.use('/sync/*', requireAuth).
//
// Flow: read `Authorization: Bearer <token>` -> hash it -> look up the session
// in SESSIONS_DB by token hash -> answer a rejected token with the code that
// says WHY -> slide a live session's idle deadline off the critical path ->
// attach the session (id, userId, accountDbId) for handlers via
// c.get('session').
//
// The four failures are four different messages to a client, and the client's
// data depends on reading them right (docs/sessions.md, _revocation, expiry and
// unknown tokens_):
//   no bearer header        401 unauthorized     — it sent no token
//   hash matches no row     401 session_unknown  — keep everything, sign in
//   row has revoked_at      401 session_revoked  — the ONLY code that may wipe
//   unrevoked, past expiry  401 session_expired  — keep everything, sign in
// Revocation is checked BEFORE expiry, so a revoked-then-expired row still
// delivers the stronger verdict.
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
  if (!token) {
    throw new HttpError(401, 'unauthorized', 'Missing bearer token');
  }

  // One server timestamp for the whole decision: the expiry check and the
  // renewal must agree on what "now" is.
  const now = Date.now();
  const session = await sessionsRepo(c.env.SESSIONS_DB).findByTokenHash(await hashToken(token));
  if (!session) {
    throw new HttpError(401, SESSION_ERROR.unknown, 'Unknown session');
  }
  if (session.revokedAt !== null) {
    throw new HttpError(401, SESSION_ERROR.revoked, 'Session revoked');
  }
  if (session.expiresAt < now) {
    throw new HttpError(401, SESSION_ERROR.expired, 'Session expired');
  }

  // SLIDING EXPIRY. Renew when the deadline has fallen more than a day behind
  // `now + idle` — a cheap pre-check off the row already read, so most requests
  // write nothing. The UPDATE's own predicate is what makes it correct under
  // concurrency and refuses to revive a revoked or expired row
  // (sessionsRepo.renew). These are PRIMARY reads, not replica reads: the
  // repository calls D1's prepare() directly, and D1 only routes to a replica
  // through the Sessions API (withSession), which this worker doesn't use —
  // adopting it would have to answer revocation freshness first.
  if (session.expiresAt < now + SESSION_IDLE_MS - SESSION_SLIDE_MS) {
    await offCriticalPath(c, renewOrReport(c, session.id, now));
  }

  c.set('session', {
    id: session.id,
    userId: session.userId,
    accountDbId: session.accountDbId,
  });
  await next();
});

// A failed renewal leaves the old deadline intact — the request it rides on was
// already authorized — so it is reported, never thrown. A later request retries
// while the session stays valid.
async function renewOrReport(c: Context<AppEnv>, sessionId: string, now: number): Promise<void> {
  try {
    await renewSession(c.env, sessionId, now);
  } catch (err) {
    console.error('requireAuth: session renewal failed', err);
  }
}

// Hand the renewal to the runtime so the response doesn't wait on a primary
// write. `app.request()` in tests (and any caller without a Workers execution
// context) has no waitUntil — Hono's getter throws — so there it is awaited
// inline instead, which also makes the specs deterministic.
async function offCriticalPath(c: Context<AppEnv>, work: Promise<void>): Promise<void> {
  let ctx: { waitUntil(promise: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (ctx) ctx.waitUntil(work);
  else await work;
}
