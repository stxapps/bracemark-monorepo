import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';

import type { AppEnv, Bindings, RateLimit } from '../lib/env';
import { HttpError } from '../lib/errors';

// Rate limiting — the same shape as bracemark-api's, minus the per-user key (the
// extractor is anonymous, so there's no session to key on; everything is per-IP).
// The actual volumes (requests / window) are set on the bindings in wrangler.jsonc.
//
// For bracemark-extractor the rate limit is LOAD-BEARING, not a nicety: an anonymous
// endpoint that fetches any URL and streams bytes is an open proxy / DDoS reflector
// / bandwidth amplifier by default (docs "Abuse caps are load-bearing"). IP rate-
// limiting alone is weak (botnets, shared NAT) — the per-response byte ceiling +
// timeout in the fetch path are its necessary complement, and the documented
// upgrade is blind capability tokens (Privacy Pass), not a session.

// The rate-limit binding names, one per volume tier. Keep in sync with the
// `ratelimits[].name` entries in wrangler.jsonc.
export const RATE_LIMIT_TIERS = {
  // Baseline (configured ~60 req / 60s).
  standard: 'API_RATE_LIMIT',
  // Stricter tier for the HTML-fetch endpoint /v1/extract (~10 req / 10s ≈ 1/s).
  tight: 'API_RATE_LIMIT_TIGHT',
  // SOLE rate limiter for /v1/image (configured ~30 req / 10s). The image proxy is
  // the PER-PAGE bottleneck — one page of N links fans out to N image fetches — so it
  // needs a wider window than /v1/extract (one batched request) to fill a page
  // without 429ing honest browsing. Unlike /extract, /v1/image is EXEMPT from the
  // `standard` 60/60s baseline (which would throttle browsing to ~1 img/s — and the
  // limiter runs before the edge-cache check, so even cache hits would count), so
  // this tier is its only request cap; the per-response byte ceiling + timeout remain
  // the real abuse floor.
  image: 'API_RATE_LIMIT_IMAGE',
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
  image: 10,
};

// The counter key. Per-IP + per-path: each (caller, endpoint) pair gets its own
// bucket, so a flood of one endpoint doesn't throttle the others.
// `cf-connecting-ip` is the real client IP set by Cloudflare's edge.
export function ipRateLimitKey(c: Context<AppEnv>): string {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  return `${ip}:${c.req.path}`;
}

// Rate-limit middleware backed by Cloudflare's native Workers Rate Limiting
// binding. `app.ts` applies the `standard` tier as a baseline on every route except
// /v1/image; the fetch endpoints set their own tier at the route level
// (/v1/extract stacks `tight` on top of the baseline, /v1/image uses `image` as its
// sole limiter — see app.ts).
export function rateLimit(tier: RateLimitTier = 'standard') {
  const bindingName = RATE_LIMIT_TIERS[tier];

  return createMiddleware<AppEnv>(async (c, next) => {
    // `c.env` is undefined under `app.request()` in tests, and the binding may be
    // absent in a misconfigured env. Fail OPEN there: an unconfigured limiter
    // shouldn't take the API down. Real envs always bind it.
    const limiter = c.env?.[bindingName] as RateLimit | undefined;
    if (!limiter) return next();

    const { success } = await limiter.limit({ key: ipRateLimitKey(c) });
    if (!success) {
      throw new HttpError(429, 'rate_limited', 'Too many requests', {
        'retry-after': String(RATE_LIMIT_PERIODS[tier]),
      });
    }
    return next();
  });
}
