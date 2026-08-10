import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { imageProxyEndpoint } from '@stxapps/shared';

import type { AppEnv, Bindings } from './lib/env';
import { errorHandler } from './lib/errors';
import { rateLimit } from './middleware/rate-limit';
import { extractRoutes } from './routes/extract';
import { imageRoutes } from './routes/image';

// bracemark-extractor — the opt-in, anonymous link-metadata fetcher on its OWN origin
// (extractor.bracemark.com), kept SEPARATE from the blind sync broker (api.bracemark.com) so
// that "api.bracemark.com only ever sees ciphertext" stays code-provable. This is the one
// component that `fetch`es arbitrary user-supplied URLs. See docs/link-extraction.md.

// Comma-separated allow-list from the Workers binding. `env` is only undefined
// off-Workers (e.g. app.request() in a test that passes no env); a missing binding
// yields an empty list, which denies all cross-origin — fail secure.
function corsOrigins(env: Bindings | undefined): string[] {
  return env?.CORS_ORIGINS?.split(',') ?? [];
}

export const app = new Hono<AppEnv>();

// Centralized error handling: middleware/handlers `throw new HttpError(...)` and this
// turns every error into a uniform JSON body. See lib/errors.ts.
app.onError(errorHandler);

// The web app (bracemark-web) is the browser caller, cross-origin, so allow CORS for the
// configured origins. The extension and the future mobile app are NOT browser-CORS-
// bound, so they aren't in the list. No `credentials` — the extractor is anonymous
// (no cookies/session), which is the whole point.
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const allow = corsOrigins(c.env as Bindings | undefined);
      return allow.includes(origin) ? origin : null;
    },
    // Let browser JS read the 429's Retry-After (middleware/rate-limit.ts) — a
    // non-safelisted response header is invisible to a CORS caller otherwise.
    exposeHeaders: ['Retry-After'],
  }),
);

// Baseline rate limit on every endpoint EXCEPT the image proxy; /v1/extract stacks
// the 'tight' tier on top at the route level. No-ops when the binding is absent
// (tests / unconfigured env). For an anonymous open-fetch service this is load-
// bearing, not a nicety — see middleware/rate-limit.ts and docs "Abuse caps are
// load-bearing".
//
// /v1/image is exempt: it's the per-page fan-out bottleneck (one page → N image
// fetches), so the 60/60s baseline would throttle honest browsing to ~1 img/s — and
// since the limiter runs before the edge-cache check, even cache hits would burn the
// budget. It carries its own wider `image` tier as its sole request cap, with the
// per-response byte ceiling + timeout (in safeFetch) as the real abuse floor.
const standardRateLimit = rateLimit('standard');
app.use('*', (c, next) =>
  c.req.path === imageProxyEndpoint.path ? next() : standardRateLimit(c, next),
);

app.get('/', (c) => {
  return c.json({ message: 'Welcome to bracemark-extractor' });
});

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// The two extraction endpoints (each carries its own '/v1/…' path from the shared
// contract, so they mount at the root).
app.route('/', extractRoutes);
app.route('/', imageRoutes);
