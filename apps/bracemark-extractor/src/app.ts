import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { fetchImageEndpoint } from '@stxapps/shared';

import type { AppEnv, Bindings } from './lib/env';
import { errorHandler } from './lib/errors';
import { rateLimit } from './middleware/rate-limit';
import { extractRoutes } from './routes/extract';
import { imageRoutes } from './routes/image';

// bracemark-extractor — the opt-in, anonymous link-metadata fetcher on its OWN origin
// (extractor.bracemark.com), kept SEPARATE from the sync broker (api.bracemark.com) so
// that "api.bracemark.com never sees your library in plaintext" stays code-provable. This
// is the one component that `fetch`es arbitrary user-supplied URLs. Say it that way and
// not "only ever sees ciphertext" — bracemark-api is one Worker over a username directory,
// an accounts shard, a sessions DB and a purchases table, so it holds plenty of plaintext;
// what it never holds is a readable link. See docs/link-extraction.md and
// docs/local-first-sync.md (_the shape of the problem_ — the callout under the
// decisive constraint).

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

// No response of this Worker may be kept by an HTTP cache — bracemark-api's rule
// (its app.ts; docs/api-contracts.md, _no response is cacheable_), and it bites
// harder here: every request this origin answers is ABOUT a saved link. The image
// proxy was a GET whose URL carried the address it fetched, so a cached response
// was a preview image, or a `…/favicon.ico` naming a saved site's host, sitting in
// the browser's own storage under that address — outside the app's, and past a
// sign-out. The proxy used to ask for exactly that (`public, max-age=86400,
// immutable`), on the argument that the browser's cache would serve a re-view. No
// client re-views: each reads the bytes once and stores them itself, encrypted or
// in the favicon store, so the cache held a second, readable copy and nothing
// read it. The proxy is a POST now and the address is in its body (the contract,
// @stxapps/shared extract/endpoints.ts), which caches do not store in practice;
// the header stays so that it is said rather than relied on.
//
// Registered FIRST so it wraps everything below it — the CORS preflight, a 429 the
// rate limiter throws, a 404, and whatever `onError` builds.
app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

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
    // Let a browser reuse a preflight, as bracemark-api does (its app.ts). Both
    // endpoints are preflighted — a JSON body is what asks — and each is one URL
    // with no query string, so one answer per endpoint covers every call for the
    // two hours Chromium allows. That is what makes the image proxy affordable as
    // a POST: a page of N previews costs one preflight, not N. This is not the
    // HTTP cache `no-store` above speaks to: a preflight entry is an origin, a
    // URL, and the methods and header names allowed on it, and neither URL that
    // gets one here names a saved link.
    maxAge: 7200,
  }),
);

// Baseline rate limit on every endpoint EXCEPT the image proxy; /v1/extract stacks
// the 'tight' tier on top at the route level. No-ops when the binding is absent
// (tests / unconfigured env). For an anonymous open-fetch service this is load-
// bearing, not a nicety — see middleware/rate-limit.ts and docs "Abuse caps are
// load-bearing".
//
// /v1/fetch-image is exempt: it's the per-page fan-out bottleneck (one page → N
// image fetches), so the 60/60s baseline would throttle honest browsing to ~1 img/s.
// It carries its own wider `image` tier as its sole request cap, with the
// per-response byte ceiling + timeout (in safeFetch) as the real abuse floor.
const standardRateLimit = rateLimit('standard');
app.use('*', (c, next) =>
  c.req.path === fetchImageEndpoint.path ? next() : standardRateLimit(c, next),
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
