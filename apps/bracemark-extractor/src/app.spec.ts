import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { app } from './app';

const deny = { limit: () => Promise.resolve({ success: false }) };

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    const res = await app.request('/', {}, { ...env, API_RATE_LIMIT: deny });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    await expect(res.json()).resolves.toEqual({
      error: 'rate_limited',
      message: 'Too many requests',
    });
  });

  it('sends Retry-After on a rate-limited image fetch (image tier, 10s window)', async () => {
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

  // /v1/extract carries the tight tier ON TOP of the baseline (routes/extract.ts),
  // so the strictest tier that rejects is the one the caller is told to wait for.
  it('stacks the tight tier on /v1/extract (10s window)', async () => {
    const res = await app.request(
      '/v1/extract',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ urls: ['https://example.com/'] }),
      },
      { ...env, API_RATE_LIMIT_TIGHT: deny },
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('10');
  });

  // The image proxy is the per-page fan-out (one page → N image fetches), so the
  // 60/60s baseline would throttle honest browsing to ~1 img/s. It is exempt by
  // PATH in app.ts, and only its own wider tier caps it.
  it('exempts /v1/image from the baseline tier that governs every other route', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
      ),
    );
    const bindings = { ...env, API_RATE_LIMIT: deny };

    const image = await app.request(
      '/v1/image?url=https%3A%2F%2Fcdn.example.com%2Fi.png',
      {},
      bindings,
    );
    expect(image.status).toBe(200);

    // Same denying baseline, any other route: rejected. So the 200 above is the
    // exemption, not a limiter that failed to run.
    const other = await app.request('/health', {}, bindings);
    expect(other.status).toBe(429);
  });

  // --- CORS ------------------------------------------------------------------
  // The extractor answers a cross-origin browser caller (bracemark-web), so the
  // allow-list is what stands between it and being anyone's open fetch proxy.

  it('echoes an allow-listed origin', async () => {
    const res = await app.request('/', { headers: { origin: 'http://localhost:3000' } }, env);

    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });

  it('refuses an origin outside the allow-list', async () => {
    const res = await app.request('/', { headers: { origin: 'https://evil.test' } }, env);

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('denies every origin when the binding is missing (fail secure)', async () => {
    // No env: an unconfigured CORS_ORIGINS must deny, never default to open.
    const res = await app.request('/', { headers: { origin: 'http://localhost:3000' } });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never allows credentials — the extractor is anonymous', async () => {
    // No cookies, no session: a credentialed CORS request would imply state the
    // service deliberately does not have.
    const res = await app.request('/', { headers: { origin: 'http://localhost:3000' } }, env);

    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
