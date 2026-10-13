import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import * as shared from '@stxapps/shared';

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
  // `password-door?username=…` (a GET then, a POST now) after the account signed
  // out of it, where no teardown reaches. Nothing here fails without the header:
  // the api behaves the same, and the residue is on someone's phone. The paths
  // are the shapes a response takes, not an inventory — a plain route, a GET
  // whose URL carries a query, a blob body, and the two the framework builds
  // itself.
  it.each([
    ['a plain route', '/health', 200],
    ['a GET whose URL carries a query', '/v1/ops/list?since=0&limit=1', 401],
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

  // A preflight with no Access-Control-Max-Age is kept for five seconds, so
  // nearly every call costs two requests and nothing says so (app.ts maxAge).
  // The number is app.ts's to choose; what is pinned is that it is far past
  // that default.
  it('lets a browser reuse a preflight', async () => {
    const res = await app.request(
      '/',
      {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' },
      },
      env,
    );

    expect(res.status).toBe(204);
    expect(Number(res.headers.get('access-control-max-age'))).toBeGreaterThanOrEqual(600);
  });

  // A GET's URL is what the request log stores, path and query both
  // (docs/api-contracts.md, _a GET's query string reaches the request log_), and
  // /privacy says no address in that log contains a username. The list of what a
  // GET may carry is `query-inventory.spec.ts` in @stxapps/shared — but that spec
  // walks the CONTRACTS, so a route mounted here by hand, with no contract, is
  // invisible to it: `.get('/v1/auth/whois/:username', …)` would answer, be
  // logged, and leave that spec green. This is the other half. Every route that
  // answers a GET is a contract the inventory already holds, or one of the three
  // named below — and adding a fourth is the moment to ask what its URL carries.
  //
  // DELETE rides with GET because the client sends its input the same way
  // (api/client.ts). What this still cannot see is a handler mounted with
  // `.all()`: Hono lists it under the method ALL, which is also how it lists
  // every `.use(path, requireAuth)` in routes/sync.ts and routes/data.ts, and
  // the two cannot be told apart from here. There is none today.
  it('answers a GET only on a contract, or on a path that carries nothing', () => {
    const urlMethods = new Set(['GET', 'DELETE']);
    const mounted = new Set(
      app.routes
        .filter((route) => urlMethods.has(route.method))
        .map((route) => `${route.method} ${route.path}`),
    );

    const contracts = (Object.values(shared) as unknown[])
      .filter(
        (value): value is { method: string; path: string } =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { method?: unknown }).method === 'string' &&
          typeof (value as { path?: unknown }).path === 'string' &&
          typeof (value as { request?: unknown }).request === 'object',
      )
      // bracemark-extractor's two contracts share the barrel and are POSTs, so
      // this filter drops them along with every POST of this api's own.
      .filter((endpoint) => urlMethods.has(endpoint.method))
      .map((endpoint) => `${endpoint.method} ${endpoint.path}`);
    // Positive control for the filter: an empty list would make the equality
    // below a statement about three paths and nothing else.
    expect(contracts).toContain(`GET ${shared.opsListEndpoint.path}`);

    expect([...mounted].sort()).toEqual(
      [
        ...contracts,
        // Operational roots: no input at all.
        'GET /',
        'GET /health',
        // The dev-only blob proxy, the one GET with a path parameter. Its key is
        // `users/{userId}/…` — ids the server minted — and it answers 404 off the
        // local env (routes/local-r2.ts).
        `GET ${LOCAL_BLOB_PATH_PREFIX}:key{.+}`,
      ].sort(),
    );
  });
});
