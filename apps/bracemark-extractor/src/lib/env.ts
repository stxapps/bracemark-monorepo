// Typed Workers runtime context for the whole extractor app. Hono is parameterized
// with `AppEnv` (see app.ts), so `c.env` (bindings) is typed in middleware + routes.
//
// bracemark-extractor runs ONLY on Cloudflare Workers (no Node entry), so every binding
// arrives on `c.env` at runtime, provided per-env by wrangler.jsonc. The one
// exception is tests: `app.request()` with no third arg runs with NO env, so
// `c.env` is `undefined` there — middleware must tolerate missing bindings (see how
// corsOrigins() and the rate-limit middleware guard for it).
//
// The binding set is deliberately TINY vs. bracemark-api: the extractor is anonymous
// and stateless (no D1/R2/DO, no key, no session), so there is nothing here but CORS
// config and the native rate limiters.

// The native Workers Rate Limiting binding. Its type isn't shipped in
// @cloudflare/workers-types yet, so declare the slice we use. Window/volume are
// configured per-binding in wrangler.jsonc; the binding only exposes
// `limit({ key })` at runtime.
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type Bindings = {
  // Comma-separated CORS allow-list (see app.ts). Set in every wrangler env.
  CORS_ORIGINS: string;

  // --- Rate limiting — native binding, one binding per volume "tier" -------
  // The native binding's window is 10s or 60s only, so a literal "1 req/sec"
  // is expressed as the tight tier (10 req / 10s). Counters are per-colo. The two
  // fetch endpoints fetch arbitrary URLs but have different load shapes: /v1/extract
  // is one (batched) request per page → `tight`; /v1/image fans out to one request
  // per link → its own higher-burst `image` tier (see middleware/rate-limit.ts).
  API_RATE_LIMIT: RateLimit; // standard tier (baseline)
  API_RATE_LIMIT_TIGHT: RateLimit; // tight tier (/v1/extract — HTML fetch)
  API_RATE_LIMIT_IMAGE: RateLimit; // burst tier (/v1/image — per-link image proxy)
};

// The extractor has no request-scoped variables (no session — it's anonymous), so
// `Variables` is empty. Kept for symmetry with bracemark-api and so a future need
// (e.g. a verified Privacy Pass token — see docs "Anonymous, not session-bound")
// has a typed home.
export type Variables = Record<string, never>;

// The single Hono generic used across the app: `new Hono<AppEnv>()`.
export type AppEnv = { Bindings: Bindings; Variables: Variables };
