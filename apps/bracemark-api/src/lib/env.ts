import type { UserDataDO } from '../do/user-data';

// Typed Workers runtime context for the whole app. Hono is parameterized with
// `AppEnv` (see app.ts), so `c.env` (bindings) and `c.var` (request-scoped
// values) are typed everywhere — middleware, routes, services.
//
// bracemark-api runs ONLY on Cloudflare Workers (no Node entry), so every binding
// below arrives on `c.env` at runtime, provided per-env by wrangler.jsonc. The
// one exception is tests: `app.request()` runs the app with NO env, so `c.env`
// is `undefined` there — middleware must tolerate missing bindings (see how
// corsOrigins() and the rate-limit middleware guard for it).

// The native Workers Rate Limiting binding. Its type isn't shipped in
// @cloudflare/workers-types yet, so declare the slice we use. Window/volume
// (`simple.limit` / `simple.period`) are configured per-binding in
// wrangler.jsonc; the binding only exposes `limit({ key })` at runtime.
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type Bindings = {
  // Comma-separated CORS allow-list (see app.ts). Set in every wrangler env.
  CORS_ORIGINS: string;

  // --- D1 (sqlite)  ----------------------
  // D1 bindings are STATIC: a Worker can't bind a database by id at runtime, so
  // every database is pre-declared here and in wrangler.jsonc. All hold ONLY
  // small, bounded-per-user rows (no bulk data — that's in USER_DATA below), so
  // none approaches D1's 10 GB cap for a long time. Three roles:
  //
  // DIRECTORY_DB — the GLOBAL, never-sharded registry: the `usernames` directory
  // (uniqueness namespace + username→shard routing). Queried directly (it owns
  // uniqueness, which can't be sharded); also the home for future global lookups.
  DIRECTORY_DB: D1Database;
  // ACCOUNTS_DB_1 — the first account SHARD: `users` (identity + credential) +
  // `account_keys` (wrapped-DEK doors), which always live together. When it nears
  // the cap, add ACCOUNTS_DB_2, … — resolve a user's shard via db/db-routes.ts
  // (accountsDb), never bind one directly outside it.
  ACCOUNTS_DB_1: D1Database;
  // SESSIONS_DB — bearer-token sessions only. Separate db: high-churn and NOT
  // Tier-0 (a lost session regenerates by re-auth), so it's isolated from the
  // account data's write traffic and backup discipline. See sessions.sql.
  SESSIONS_DB: D1Database;

  // --- Durable Objects — one per-user SQLite store ----------------------
  // Addressed by idFromName(userId) (see do/user-data.ts → userDataStub). Holds
  // the user's op log (and any future per-user data). The generic gives typed
  // RPC against the DO class's methods.
  USER_DATA: DurableObjectNamespace<UserDataDO>;

  // --- R2 — encrypted bookmark blobs (see docs/local-first-sync.md) -------
  // The binding reads/writes objects from inside the Worker (commit HEADs, the
  // fallback listing). It can NOT mint browser-usable signed URLs, so `files/sign`
  // presigns R2's S3 endpoint with the access keys below instead (r2/presign.ts).
  // All R2 access goes through the r2/user-files gateway.
  USER_FILES: R2Bucket;

  // R2 S3-API credentials for presigning. Account id + bucket name are non-secret
  // `vars`; the access key pair are SECRETS (`wrangler secret put R2_ACCESS_KEY_ID
  // / R2_SECRET_ACCESS_KEY --env …`). All are per-env (see wrangler.jsonc). The
  // account id + access keys are account-scoped, so they're shared across every
  // bucket; only the bucket *name* is per-bucket (hence the `_USER_FILES_` infix —
  // a second bucket gets its own `R2_<NAME>_BUCKET` var, same creds). The name is
  // duplicated here because the runtime R2 binding doesn't expose its own name,
  // and the S3 endpoint path needs it.
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_USER_FILES_BUCKET: string;

  // --- Paddle Billing (IAP) ------------------------------------------------
  // Paddle is the web checkout provider; bracemark-api
  // consumes its webhook + portal API (routes/iap.ts, services/iap.ts).
  // PADDLE_API_BASE + the price ids are non-secret `vars` (sandbox and live
  // Paddle mint different pri_… ids, so they're per-env); the webhook secret
  // and API key are SECRETS (`wrangler secret put PADDLE_WEBHOOK_SECRET /
  // PADDLE_API_KEY --env …`; locally in .dev.vars).
  //
  // Each PADDLE_PRICE_ID_* is a COMMA-SEPARATED LIST, not one id — a plan may
  // carry several prices at once (a second billing cadence, a grandfathered
  // launch price), and the READ side must recognize every price the catalog has
  // ever charged or the webhook drops that subscriber permanently. The FIRST
  // entry is the one checkout sells. See services/iap.ts, paddlePriceIds.
  PADDLE_API_BASE: string;
  PADDLE_PRICE_ID_PLUS: string;
  PADDLE_PRICE_ID_PRO: string;
  PADDLE_WEBHOOK_SECRET: string;
  PADDLE_API_KEY: string;

  // --- store IAP (bracemark-expo) ----------------------------------------------
  // App Store / Play Store verification (routes/iap.ts `iap/verify` + the
  // notify webhooks; lib/appstore.ts, lib/playstore.ts). Unlike Paddle there
  // are no per-env product ids here — store product ids are ours and identical
  // across sandbox/production, so they live in @stxapps/shared
  // (iap/store-products.ts).
  //
  // App Store Server API: base is per-env (sandbox for development/staging,
  // production for production — production also falls back to sandbox on 404
  // for App Review, see lib/appstore.ts). ISSUER_ID/KEY_ID identify the In-App
  // Purchase key (App Store Connect → Integrations); the key's PKCS#8 PEM is a
  // SECRET (`wrangler secret put APPSTORE_PRIVATE_KEY --env …`; .dev.vars
  // locally).
  APPSTORE_API_BASE: string;
  APPSTORE_ISSUER_ID: string;
  APPSTORE_KEY_ID: string;
  APPSTORE_BUNDLE_ID: string;
  APPSTORE_PRIVATE_KEY: string;
  // Play Developer API: a service account with "View financial data" on the
  // Play Console account. There is deliberately no PLAY_API_BASE analogue —
  // Google ships one host for every purchase (test purchases included; see
  // lib/playstore.ts), so Play's per-env dimension is the package name + service
  // account below, not a base URL. SA_EMAIL is the account's client_email; the key's
  // PKCS#8 PEM (the JSON's private_key field) is a SECRET
  // (`wrangler secret put PLAY_SA_PRIVATE_KEY --env …`). PLAY_NOTIFY_TOKEN is
  // the static `?token=` guard on the Pub/Sub push endpoint (any long random
  // string; also a SECRET) — include it in the push subscription's URL.
  PLAY_PACKAGE_NAME: string;
  PLAY_SA_EMAIL: string;
  PLAY_SA_PRIVATE_KEY: string;
  PLAY_NOTIFY_TOKEN: string;

  // --- Rate limiting — native binding, one binding per volume "tier" -------
  // The native binding's window is 10s or 60s only, so a literal "1 req/sec"
  // is expressed as the tight tier (10 req / 10s). Counters are per-colo.
  API_RATE_LIMIT: RateLimit; // standard tier
  API_RATE_LIMIT_TIGHT: RateLimit; // tight tier (sensitive endpoints)
  API_RATE_LIMIT_WEBHOOK: RateLimit; // wide tier (sole limiter for the Paddle webhook)
};

// The session resolved by the auth guard (middleware/auth.ts) and read by
// protected handlers via `c.get('session')`.
export type SessionContext = {
  id: string;
  userId: string;
  // The user's accounts shard (e.g. '1'), carried from the session so protected
  // handlers route account/data reads without a directory hop. See db/db-routes.ts.
  accountDbId: string;
};

export type Variables = {
  session: SessionContext;
};

// The single Hono generic used across the app: `new Hono<AppEnv>()`.
export type AppEnv = { Bindings: Bindings; Variables: Variables };
