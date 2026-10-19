import { Hono } from 'hono';
import { cors } from 'hono/cors';

import type { AppEnv, Bindings } from './lib/env';
import { errorHandler } from './lib/errors';
import { serverTiming } from './lib/server-timing';
import { rateLimit } from './middleware/rate-limit';
import { authRoutes } from './routes/auth';
import { dataRoutes } from './routes/data';
import {
  APPSTORE_NOTIFY_PATH,
  iapRoutes,
  PADDLE_WEBHOOK_PATH,
  PLAYSTORE_NOTIFY_PATH,
} from './routes/iap';
import { localR2Routes } from './routes/local-r2';
import { syncRoutes } from './routes/sync';

// Comma-separated allow-list from the Workers binding. `env` is only undefined
// off-Workers (e.g. app.request() in a test that passes no env); a missing
// binding yields an empty list, which denies all cross-origin — fail secure.
function corsOrigins(env: Bindings | undefined): string[] {
  return env?.CORS_ORIGINS?.split(',') ?? [];
}

export const app = new Hono<AppEnv>();

// Centralized error handling: middleware/handlers `throw new HttpError(...)` and
// this turns every error into a uniform JSON body. See lib/errors.ts.
app.onError(errorHandler);

// No response of this api may be kept by an HTTP cache, and it says so itself:
// a response with no `Cache-Control` is one a client's cache is free to store.
// React Native's OkHttp cache on Android did — every GET here, request URL
// included, so a device held `password-door?username=…` (a GET at the time; the
// username lookups are POSTs now, for the server-side twin of this reason) and
// the account's object keys after the account had signed out of it, in a
// directory no teardown reaches (docs/api-contracts.md, _no response is
// cacheable_). A
// browser's cache and iOS's URL cache are the same kind of place. `no-store`
// rather than `no-cache`: the point is that nothing is written, not that it is
// revalidated.
//
// Registered FIRST so it wraps everything below it — the CORS preflight, a 429
// the rate limiter throws, a 404, and whatever `onError` builds. A route that
// ever wants to be cached has to be exempted here, on purpose.
app.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

// Browser clients are cross-origin (bracemark-web dev on :3000, the extension from
// its own origin), so allow CORS. The allow-list is resolved per-request from
// the runtime env; credentials require echoing the specific origin (not '*').
app.use(
  '*',
  cors({
    origin: (origin, c) => {
      const allow = corsOrigins(c.env as Bindings | undefined);
      return allow.includes(origin) ? origin : null;
    },
    credentials: true,
    // Let browser JS read the 429's Retry-After (middleware/rate-limit.ts) — a
    // non-safelisted response header is invisible to a CORS caller otherwise.
    exposeHeaders: ['Retry-After'],
    // Let a browser reuse a preflight instead of sending one before every call.
    // Nearly every request here is preflighted — a JSON body or the
    // `authorization` header is enough — and since the username lookups became
    // POSTs that includes the check that fires as someone types a name
    // (auth/endpoints.ts in @stxapps/shared). Two hours is Chromium's ceiling;
    // other engines apply their own, lower or higher. The entry is per URL, query
    // string included, so a GET whose cursor moves (ops/list, files/list) asks
    // again. The cost is small: an origin REMOVED from CORS_ORIGINS keeps
    // skipping the preflight for that long in a browser that already asked, so
    // its requests still arrive — but the answer is refused to it at once,
    // because the allow-list is read on every response. An origin added works
    // immediately; a refused preflight is not kept.
    maxAge: 7200,
  }),
);

// The Server-Timing breakdown, where SERVER_TIMING turns it on (development and
// staging; lib/server-timing.ts). After CORS, before everything that waits on a
// store, so `total` covers the rate limiter, the auth read and the handler.
app.use('*', serverTiming);

// Baseline rate limit on every endpoint EXCEPT the provider webhooks (standard
// tier, ~60 req/60s per IP+path; configured in wrangler.jsonc). Sensitive routes
// stack the 'tight' tier on top at the route level, e.g. rateLimit('tight').
// No-ops when the binding is absent (tests / unconfigured env). See
// middleware/rate-limit.ts.
//
// The webhooks are exempt from THIS baseline: each provider's deliveries arrive
// from a small set of provider IPs onto one path, so they'd share a single
// IP+path bucket — a burst or redelivery storm could 429 legitimate events
// (which the provider then just redelivers into the same saturated bucket).
// They aren't left uncapped, though: each carries the wider 'webhook' tier at
// the route level (routes/iap.ts) as its sole request cap. Their real auth is
// not a request count — Paddle's is the Paddle-Signature HMAC over the raw
// body; the store notify routes re-fetch authoritative state from the store's
// API instead of trusting the payload (see routes/iap.ts), so a forged flood
// costs an attacker a rate-limited no-op.
const WEBHOOK_PATHS = new Set([PADDLE_WEBHOOK_PATH, APPSTORE_NOTIFY_PATH, PLAYSTORE_NOTIFY_PATH]);
const standardRateLimit = rateLimit('standard');
app.use('*', (c, next) => (WEBHOOK_PATHS.has(c.req.path) ? next() : standardRateLimit(c, next)));

app.get('/', (c) => {
  return c.json({ message: 'Welcome to bracemark-api' });
});

app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

app.route('/', authRoutes);

// Subscription surface: status/verify/portal (contract-typed) + the Paddle
// webhook (HMAC-authenticated, no bearer). See routes/iap.ts.
app.route('/', iapRoutes);

// Local-first sync control plane (ops/list, ops/commit, files/list, files/sign).
// All four are protected and namespace every path under the authed user; see
// routes/sync.ts and docs/local-first-sync.md.
app.route('/', syncRoutes);

// Data lifecycle (delete-all). Protected, destructive, whole-namespace — beside
// the sync plane, not in it. See routes/data.ts and docs/data-lifecycle.md.
app.route('/', dataRoutes);

// DEV-ONLY blob proxy (routes/local-r2.ts). Always mounted but self-gates to 404
// off the local miniflare env, so it's inert in staging/prod (which presign R2
// directly). It stands in for direct browser↔R2 transfer under `wrangler dev`,
// where the emulated bucket has no presignable S3 endpoint.
app.route('/', localR2Routes);
