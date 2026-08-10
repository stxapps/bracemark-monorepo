import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import { dataDeleteAllEndpoint, type DataDeleteAllResponse } from '@stxapps/shared';

import type { AppEnv } from '../lib/env';
import { requireAuth } from '../middleware/auth';
import { rateLimit, userRateLimitKey } from '../middleware/rate-limit';
import { deleteAllUserData } from '../services/sync';

// Data-lifecycle routes — the destructive whole-namespace actions beside the
// four-endpoint sync control plane (routes/sync.ts). One route today:
// delete-all-data. See docs/data-lifecycle.md.
export const dataRoutes = new Hono<AppEnv>()
  .use(dataDeleteAllEndpoint.path, requireAuth)
  // --- data/delete-all — wipe the user's whole data plane -------------------
  .post(
    dataDeleteAllEndpoint.path,
    // Per-user tight tier like the other authed write paths (ops/commit,
    // files/sign): the wipe itself is idempotent and cheap to repeat, but each
    // run pages the whole R2 prefix — no reason to let one account hammer it.
    rateLimit('tight', userRateLimitKey),
    zValidator('json', dataDeleteAllEndpoint.request),
    async (c) => {
      const { userId } = c.get('session');
      // DO wipe first, then the paged R2 prefix delete — the ordering (and why
      // other devices converge via the fallback) is documented on the service.
      // The session, account rows, and subscription are untouched: this deletes
      // the bytes, not the identity (account deletion is /v1/auth/delete-account).
      const body: DataDeleteAllResponse = await deleteAllUserData(c.env, userId);
      return c.json(body);
    },
  );
