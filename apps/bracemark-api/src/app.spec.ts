import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

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

  // Retry-After is not CORS-safelisted, so browser JS only sees it if the CORS
  // layer exposes it (app.ts exposeHeaders) — pin that wiring.
  it('exposes Retry-After to CORS callers', async () => {
    const res = await app.request('/', {}, env);

    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After');
  });
});
