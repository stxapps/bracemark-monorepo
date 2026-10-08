import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { userFileKey } from './r2/keys';
import { LOCAL_BLOB_PATH_PREFIX } from './r2/local';
import { app } from './app';

// app.request(path, init, env) — the third arg is the bindings the handlers see.
// Under vitest-pool-workers `env` is the REAL local Workers env (D1/R2/DO/rate
// limits). Storage is isolated per test (see vitest.config.ts) and seeded with
// migrations only. Route-group coverage lives next to each router
// (routes/auth.spec.ts, routes/sync.spec.ts); this file covers only the
// app-level routes defined in app.ts.
describe('bracemark-api', () => {
  it('returns a welcome message on the root route', async () => {
    const res = await app.request('/', {}, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      message: 'Welcome to bracemark-api',
    });
  });

  it('reports a healthy status', async () => {
    const res = await app.request('/health', {}, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });

  // The real binding would need 60 requests to trip, so swap in a denying fake:
  // what's under test is the 429 envelope + the Retry-After header (the standard
  // tier's 60s window — middleware/rate-limit.ts RATE_LIMIT_PERIODS).
  it('sends Retry-After on a rate-limited request', async () => {
    const deny = { limit: async () => ({ success: false }) };
    const res = await app.request('/', {}, { ...env, API_RATE_LIMIT: deny });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    await expect(res.json()).resolves.toEqual({
      error: 'rate_limited',
      message: 'Too many requests',
    });
  });

  // A response that says nothing about caching may be stored, and Android's
  // HTTP cache did store every GET — request URL and all, so a device kept
  // `password-door?username=…` after the account signed out of it, where no
  // teardown reaches. Nothing here fails without the header: the api behaves the
  // same, and the residue is on someone's phone. The paths are the shapes a
  // response takes, not an inventory — a plain route, one whose URL carries the
  // username, a blob body, and the two the framework builds itself.
  it.each([
    ['a plain route', '/health', 200],
    ['a URL that carries the username', '/v1/auth/password-door?username=nobody_here', 404],
    ['a path nothing answers', '/v1/nothing-here', 404],
  ])('tells caches to store nothing: %s', async (_name, path, status) => {
    const res = await app.request(path, {}, env);

    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  // The blob proxy answers with a stream rather than JSON, and it is the response
  // whose URL is the account's object key.
  it('tells caches to store nothing: a blob', async () => {
    const key = userFileKey('cache-control-1', 'links/a.enc');
    await env.USER_FILES.put(key, 'ciphertext');

    const res = await app.request(`${LOCAL_BLOB_PATH_PREFIX}${key}`, {}, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.text()).resolves.toBe('ciphertext');
  });

  // The limiter THROWS, so this response is built by onError — and the limiter is
  // registered after the header's middleware. Registered the other way round, a
  // 429 would be the one response without it.
  it('tells caches to store nothing: a rate-limited request', async () => {
    const deny = { limit: async () => ({ success: false }) };
    const res = await app.request('/', {}, { ...env, API_RATE_LIMIT: deny });

    expect(res.status).toBe(429);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  // Retry-After is not CORS-safelisted, so browser JS only sees it if the CORS
  // layer exposes it (app.ts exposeHeaders) — pin that wiring.
  it('exposes Retry-After to CORS callers', async () => {
    const res = await app.request('/', {}, env);

    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After');
  });
});
