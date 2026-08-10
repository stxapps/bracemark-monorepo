import { Hono } from 'hono';

import type { AppEnv } from '../lib/env';
import { isLocalR2, LOCAL_BLOB_PATH_PREFIX } from '../r2/local';

// DEV-ONLY blob proxy for `wrangler dev` — the local stand-in for direct
// browser↔R2 transfer (see r2/local.ts for why presigned URLs can't reach
// miniflare's emulated bucket). GET/PUT a blob through the USER_FILES binding,
// keyed by the full namespaced object key minted by files/sign (`users/{userId}/…`)
// — so authorization rode along in the URL exactly as a presign's signature would;
// this route adds no further auth (local-only, emulated bucket).
//
// Always mounted in app.ts, but self-gates to 404 off the local placeholder env,
// so it's inert in staging/prod (which presign R2 directly).
const BLOB_ROUTE = `${LOCAL_BLOB_PATH_PREFIX}:key{.+}`;

export const localR2Routes = new Hono<AppEnv>()
  .get(BLOB_ROUTE, async (c) => {
    if (!isLocalR2(c.env)) return c.notFound();

    const key = c.req.param('key');
    const object = await c.env.USER_FILES.get(key);
    if (!object) return c.notFound();

    return c.body(object.body);
  })
  .put(BLOB_ROUTE, async (c) => {
    if (!isLocalR2(c.env)) return c.notFound();

    const key = c.req.param('key');
    await c.env.USER_FILES.put(key, await c.req.arrayBuffer());
    return c.body(null, 200);
  });
