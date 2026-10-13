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

  // Every request this Worker answers is about a saved link, so no response may
  // be kept by an HTTP cache (app.ts). Nothing here fails without the header — the
  // residue is in a browser profile — and the shapes below are the ones the
  // framework builds itself: a plain route, a path nothing answers, and a 429,
  // which the limiter THROWS, so it is onError's response and proves the header's
  // middleware is registered ahead of the limiter. routes/image.spec.ts pins the
  // proxy's own.
  it.each([
    ['a plain route', '/health', 200, {}],
    ['a path nothing answers', '/v1/nothing-here', 404, {}],
    ['a rate-limited request', '/', 429, { API_RATE_LIMIT: deny }],
  ])('tells caches to store nothing: %s', async (_name, path, status, bindings) => {
    const res = await app.request(path, {}, { ...env, ...bindings });

    expect(res.status).toBe(status);
    expect(res.headers.get('cache-control')).toBe('no-store');
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
    // The image tier 429s before body validation, so no `url` is needed.
    const res = await app.request(
      '/v1/fetch-image',
      { method: 'POST' },
      { ...env, API_RATE_LIMIT_IMAGE: deny },
    );

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('10');
  });

  // Retry-After is not CORS-safelisted, so browser JS only sees it if the CORS
  // layer exposes it (app.ts exposeHeaders) — pin that wiring.
  it('exposes Retry-After to CORS callers', async () => {
    const res = await app.request('/', {}, env);

    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After');
  });

  // A preflight with no Access-Control-Max-Age is kept for five seconds, so every
  // extract costs two requests and nothing says so (app.ts maxAge). The number is
  // app.ts's to choose; what is pinned is that it is far past that default.
  //
  // Both paths, and the image proxy is the one that needs it: it is a POST for the
  // address's sake (routes/image.ts) and a page fans out to one call per preview,
  // so without a kept preflight every image would cost two requests.
  it.each(['/v1/extract', '/v1/fetch-image'])(
    'lets a browser reuse a preflight: %s',
    async (path) => {
      const res = await app.request(
        path,
        {
          method: 'OPTIONS',
          headers: {
            origin: 'http://localhost:3000',
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'content-type',
          },
        },
        env,
      );

      expect(res.status).toBe(204);
      expect(Number(res.headers.get('access-control-max-age'))).toBeGreaterThanOrEqual(600);
      expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
    },
  );

  // The proxy has its own request cap, so a preflight must not spend it: the CORS
  // layer answers an OPTIONS before any limiter runs.
  it('answers the image proxy’s preflight without charging its rate limit', async () => {
    const res = await app.request(
      '/v1/fetch-image',
      {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' },
      },
      { ...env, API_RATE_LIMIT_IMAGE: deny },
    );

    expect(res.status).toBe(204);
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
  it('exempts /v1/fetch-image from the baseline tier that governs every other route', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
      ),
    );
    const bindings = { ...env, API_RATE_LIMIT: deny };

    const image = await app.request(
      '/v1/fetch-image',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://cdn.example.com/i.png' }),
      },
      bindings,
    );
    expect(image.status).toBe(200);

    // Same denying baseline, any other route: rejected. So the 200 above is the
    // exemption, not a limiter that failed to run.
    const other = await app.request('/health', {}, bindings);
    expect(other.status).toBe(429);
  });

  // No URL this Worker answers may carry a saved address, and since the image
  // proxy became a POST none can: both endpoints take theirs in a body
  // (docs/api-contracts.md, _a GET's query string reaches the request log_).
  // routes/image.spec.ts pins that the OLD shape is gone; this pins that there is
  // no new one. A GET added here — `/v1/favicon?host=…` is the obvious next — puts
  // a saved site in a request line, which the zone's firewall events record
  // whatever `invocation_logs` says, and nothing else fails: the contract
  // inventory in @stxapps/shared only sees a route that has a contract.
  //
  // DELETE rides with GET: the client sends its input as a query string too
  // (api/client.ts). A handler mounted with `.all()` is the one shape this does
  // not see — Hono lists it under ALL, beside the middleware in app.ts.
  it('answers a GET on the two operational roots and nothing else', () => {
    const urlMethods = new Set(['GET', 'DELETE']);
    const mounted = new Set(
      app.routes
        .filter((route) => urlMethods.has(route.method))
        .map((route) => `${route.method} ${route.path}`),
    );

    expect([...mounted].sort()).toEqual(['GET /', 'GET /health']);
    // Positive control: the walk does see the endpoints, so the list above is
    // short because they are POSTs and not because nothing was read.
    expect(app.routes.map((route) => `${route.method} ${route.path}`)).toEqual(
      expect.arrayContaining(['POST /v1/extract', 'POST /v1/fetch-image']),
    );
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
