import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import type { AppEnv, Bindings, RateLimit } from '../lib/env';
import { HttpError } from '../lib/errors';

// Rate limiting — tiers, key strategies, and the middleware that uses them, all
// in one place (the middleware is the only consumer). The actual volumes
// (requests / window) are set on the bindings in wrangler.jsonc — the native
// binding only allows a 10s or 60s window, so a "1 req/sec" feel is the TIGHT
// tier (10 req / 10s). Here we just name the tiers and pick a key strategy;
// routes choose a tier.
//
// To add a new volume tier: add a `[[ratelimits]]` binding in wrangler.jsonc,
// declare it on `Bindings` (lib/env.ts), and add it to RATE_LIMIT_TIERS.

// The rate-limit binding names, one per volume tier. Keep in sync with the
// `ratelimits[].name` entries in wrangler.jsonc.
export const RATE_LIMIT_TIERS = {
  // Baseline applied to every endpoint (configured ~60 req / 60s).
  standard: 'API_RATE_LIMIT',
  // Stricter tier for sensitive/expensive endpoints (~10 req / 10s ≈ 1/s).
  tight: 'API_RATE_LIMIT_TIGHT',
  // WIDE tier, sole limiter for the Paddle webhook (configured ~100 req / 10s).
  // All of Paddle's deliveries arrive from a small set of Paddle IPs onto one
  // path, so they share a single IP+path bucket — far too much for the 60/60s
  // `standard` baseline, which a redelivery storm after an outage would trip
  // (Paddle then just redelivers into the same saturated bucket). The webhook is
  // EXEMPT from `standard` and carries this tier instead: wide enough that real
  // Paddle bursts never 429, tight enough to bound an attacker who finds the URL
  // to ~10 cheap signature checks/sec/IP (the HMAC over the raw body is the real
  // auth — see routes/iap.ts). Per-IP, like `standard` (the caller is anonymous
  // Paddle — no session to key on).
  webhook: 'API_RATE_LIMIT_WEBHOOK',
  // PER-USER tier, sole limiter for the blob route (routes/blob.ts), which is
  // EXEMPT from `standard` for the webhook's reason inverted: it is one path for
  // every object, so an IP+path bucket sized for API calls would 429 a sync's
  // transfers within seconds. Keyed by the user the blob token names
  // (blobRateLimitKey), not the IP. Wide on purpose (configured 10,000 req /
  // 10s): it bounds replaying a token — a GET token is good for an hour — and
  // must never bound a sync, because a 429 here FAILS that transfer, and a pull
  // fails whole on one (the engines retry a cycle, not a transfer). The bucket is
  // the account's, so every device of it shares it, and a fast path is fast:
  // locally one account's two browsers went past 2,000 in 10 s (a floor leg's
  // 1,920 GETs, then a push), and 99 PUTs were refused. A 24-wide fan-out reaches
  // 10,000 only below a 24 ms round trip.
  blob: 'API_RATE_LIMIT_BLOB',
} as const satisfies Record<string, keyof Bindings>;

export type RateLimitTier = keyof typeof RATE_LIMIT_TIERS;

// Each tier's window length in seconds — keep in sync with the `simple.period`
// values in wrangler.jsonc (the native binding only allows 10 or 60). Sent as
// `Retry-After` on a 429: the binding doesn't expose the window's actual reset
// time, so the full period is the conservative ceiling — waiting it out always
// lands the client in a fresh window.
export const RATE_LIMIT_PERIODS: Record<RateLimitTier, number> = {
  standard: 60,
  tight: 10,
  webhook: 10,
  blob: 10,
};

// The counter key. Per-IP + per-path by default: each (caller, endpoint) pair
// gets its own bucket, so a flood of one endpoint doesn't throttle the others.
// `cf-connecting-ip` is the real client IP set by Cloudflare's edge.
export function ipRateLimitKey(c: Context<AppEnv>): string {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  return `${ip}:${c.req.path}`;
}

// Key an authenticated endpoint by user instead of IP, so a single account
// can't multiply its quota across IPs (and shared IPs don't collide). Falls
// back to IP when there's no session yet. Use as the `key` arg to rateLimit().
export function userRateLimitKey(c: Context<AppEnv>): string {
  const userId = c.get('session')?.userId;
  if (userId) return `user:${userId}:${c.req.path}`;
  return ipRateLimitKey(c);
}

// Key the blob route by the user its token grants (routes/blob.ts), which has no
// session. Falls back to IP if the grant is somehow absent; the route's token
// check runs first, so it never is.
export function blobRateLimitKey(c: Context<AppEnv>): string {
  const userId = c.get('blobGrant')?.userId;
  if (userId) return `blob:${userId}`;
  return ipRateLimitKey(c);
}

// Name the account a refused blob transfer was for. The invocation log already
// has the IP beside every request, but not the account: the token that names it
// rides in the masked `authorization` header or, on a browser read, in a body the
// log never stores. A sync stays far under this tier, so a refusal is the abuse
// signal, and this line is what makes an account-wide response possible against
// a replayer who rotates IPs. The account id only — never the path, which would
// put which object was read into the log (docs/local-first-sync.md, _the blob
// route_).
//
// Once per account per window per isolate: past the limit every request is
// refused, and a line for each would add a log event to a flood that is already
// costing one.
//
// Bounded by time, not a count: an entry is re-inserted on each line, so the
// map's insertion order is oldest-logged first, and every refusal drops the
// expired entries off the front. What it holds is the accounts refused in the
// last window — a cap by count would instead forget an account early under a
// many-account flood, and log it again.
const blobRefusalLogged = new Map<string, number>();

function noteBlobRefusal(c: Context<AppEnv>): void {
  const userId = c.get('blobGrant')?.userId;
  if (!userId) return;
  const now = Date.now();
  const windowMs = RATE_LIMIT_PERIODS.blob * 1000;
  for (const [id, at] of blobRefusalLogged) {
    if (now - at < windowMs) break;
    blobRefusalLogged.delete(id);
  }
  if (blobRefusalLogged.has(userId)) return;
  blobRefusalLogged.set(userId, now);
  console.warn(`rateLimit: blob tier refused ${userId}`);
}

// Rate-limit middleware backed by Cloudflare's native Workers Rate Limiting
// binding. `app.ts` applies the `standard` tier globally (`app.use('*', …)`);
// individual routes can stack a stricter tier on top, e.g.:
//
//   authRoutes.post('/auth/account', rateLimit('tight'), handler)
//
// Each tier maps to a separate binding (volume is configured in wrangler.jsonc).
// The counter `key` defaults to IP+path; pass a custom key fn (e.g.
// userRateLimitKey) for per-user limits on authed routes.
export function rateLimit(
  tier: RateLimitTier = 'standard',
  key: (c: Context<AppEnv>) => string = ipRateLimitKey,
) {
  const bindingName = RATE_LIMIT_TIERS[tier];

  return createMiddleware<AppEnv>(async (c, next) => {
    // `c.env` is undefined under `app.request()` in tests, and the binding may
    // be absent in a misconfigured env. Fail OPEN there: an unconfigured
    // limiter shouldn't take the API down. Real envs always bind it.
    const limiter = c.env?.[bindingName] as RateLimit | undefined;
    if (!limiter) return next();

    const { success } = await limiter.limit({ key: key(c) });
    if (!success) {
      if (tier === 'blob') noteBlobRefusal(c);
      throw new HttpError(429, 'rate_limited', 'Too many requests', {
        'retry-after': String(RATE_LIMIT_PERIODS[tier]),
      });
    }
    return next();
  });
}
