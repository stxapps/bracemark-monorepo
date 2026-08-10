import { createMiddleware } from 'hono/factory';

import { sessionsRepo } from '../db/repositories/sessions';
import type { AppEnv } from '../lib/env';
import { HttpError } from '../lib/errors';
import { hashToken } from '../lib/ids';

// Auth guard. Apply to protected route groups (NOT globally) once endpoints
// land, e.g.:  app.use('/sync/*', requireAuth)
//
// Flow: read `Authorization: Bearer <token>` -> hash it -> look up the session
// in SESSIONS_DB by token hash -> reject if missing/expired -> attach the
// session (id, userId, accountDbId) to the context for handlers via
// c.get('session').
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
  if (!token) {
    throw new HttpError(401, 'unauthorized', 'Missing bearer token');
  }

  const session = await sessionsRepo(c.env.SESSIONS_DB).findByTokenHash(await hashToken(token));
  if (!session || session.expiresAt < Date.now()) {
    throw new HttpError(401, 'unauthorized', 'Invalid or expired session');
  }

  // NOTE: we deliberately do NOT bump `last_seen_at` here. Nothing reads it yet,
  // and an UPDATE on every authenticated request is a write on the hot path (D1
  // writes go to the primary region, unlike the replica-served read above). When a
  // feature needs it (sessions/devices UI, sliding expiry), do it THROTTLED and OFF
  // the critical path: only write when last_seen_at is stale (e.g. >10 min — add it
  // to findByTokenHash first), and fire it via c.executionCtx.waitUntil so it never
  // blocks the response.

  c.set('session', {
    id: session.id,
    userId: session.userId,
    accountDbId: session.accountDbId,
  });
  await next();
});
