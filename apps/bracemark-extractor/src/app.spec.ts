import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { app } from './app';

// app.request(path, init, env) — the third arg is the bindings the handlers see.
// Under vitest-pool-workers `env` is the REAL local Workers env (rate limits).
describe('bracemark-extractor', () => {
  it('returns a welcome message on the root route', async () => {
    const res = await app.request('/', {}, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ message: 'Welcome to bracemark-extractor' });
  });

  it('reports a healthy status', async () => {
    const res = await app.request('/health', {}, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'ok' });
  });

  // The real bindings would need a full window's worth of requests to trip, so swap
  // in a denying fake: what's under test is the 429 envelope + the Retry-After
  // header carrying each tier's window (middleware/rate-limit.ts RATE_LIMIT_PERIODS).
  it('sends Retry-After on a rate-limited request (standard tier, 60s window)', async () => {
    const deny = { limit: async () => ({ success: false }) };
    const res = await app.request('/', {}, { ...env, API_RATE_LIMIT: deny });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    await expect(res.json()).resolves.toEqual({
      error: 'rate_limited',
      message: 'Too many requests',
    });
  });

  it('sends Retry-After on a rate-limited image fetch (image tier, 10s window)', async () => {
    const deny = { limit: async () => ({ success: false }) };
    // The image tier 429s before query validation, so no ?url= is needed.
    const res = await app.request('/v1/image', {}, { ...env, API_RATE_LIMIT_IMAGE: deny });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('10');
  });

  // Retry-After is not CORS-safelisted, so browser JS only sees it if the CORS
  // layer exposes it (app.ts exposeHeaders) — pin that wiring.
  it('exposes Retry-After to CORS callers', async () => {
    const res = await app.request('/', {}, env);

    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After');
  });
});
