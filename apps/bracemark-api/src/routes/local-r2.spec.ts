import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { app } from '../app';
import { userFileKey } from '../r2/keys';
import { LOCAL_BLOB_PATH_PREFIX, localBlobUrl } from '../r2/local';

// The dev blob proxy is an UNAUTHENTICATED read/write of any object in the
// bucket by key — safe only because it self-gates to 404 off the local
// miniflare env. routes/sync.spec.ts round-trips a blob through it in the
// `development` env (where it is live); the case nothing else covers is the
// other side of that gate, which is the one that matters: if it stops firing,
// staging and production expose the whole bucket and every test still passes.
describe('the dev blob proxy', () => {
  // A real (non-placeholder) account id is the only difference from the env the
  // rest of the suite runs under — that alone must turn the route off.
  const deployedEnv = { ...env, R2_ACCOUNT_ID: 'a1b2c3d4e5f6000000000000000000ab' };

  it('404s a GET of an existing object once R2 is not the local emulation', async () => {
    const key = userFileKey('proxy-gate-1', 'links/a.enc');
    await env.USER_FILES.put(key, 'ciphertext');
    // Live in the local env, so the 404 below is the gate and not a missing object.
    expect((await app.request(`${LOCAL_BLOB_PATH_PREFIX}${key}`, {}, env)).status).toBe(200);

    const res = await app.request(`${LOCAL_BLOB_PATH_PREFIX}${key}`, {}, deployedEnv);

    expect(res.status).toBe(404);
  });

  it('404s a PUT and writes nothing once R2 is not the local emulation', async () => {
    const key = userFileKey('proxy-gate-2', 'links/b.enc');

    const res = await app.request(
      `${LOCAL_BLOB_PATH_PREFIX}${key}`,
      { method: 'PUT', body: 'ciphertext' },
      deployedEnv,
    );

    expect(res.status).toBe(404);
    expect(await env.USER_FILES.head(key)).toBeNull();
  });

  // The URL is built by encoding each segment rather than the whole key, so the
  // '/' separators stay path separators for the route's `:key{.+}` param. Encode
  // the key as one string and every blob URL becomes a single escaped segment
  // that no longer matches the route.
  it('mints proxy URLs whose key separators stay literal', () => {
    const url = new URL(localBlobUrl('users/u1/links/a.enc'));

    expect(url.pathname).toBe(`${LOCAL_BLOB_PATH_PREFIX}users/u1/links/a.enc`);
  });
});
