import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import {
  API_V1,
  iapCheckoutEndpoint,
  type IapCheckoutResponse,
  iapPortalEndpoint,
  type IapPortalResponse,
  iapPricesEndpoint,
  type IapPricesResponse,
  iapStatusEndpoint,
  iapVerifyEndpoint,
  type SubscriptionStatus,
} from '@stxapps/shared';

import { appstoreNotificationTransactionId } from '../lib/appstore';
import type { AppEnv, Bindings } from '../lib/env';
import { HttpError } from '../lib/errors';
import { paddleEventSchema, verifyPaddleSignature } from '../lib/paddle';
import { playNotificationPurchaseToken } from '../lib/playstore';
import type { StoreSource } from '../lib/store';
import { requireAuth } from '../middleware/auth';
import { rateLimit, userRateLimitKey } from '../middleware/rate-limit';
import {
  applyPaddleEvent,
  applyStoreNotification,
  createPaddlePortalSession,
  createPaddleTransaction,
  getSubscriptionStatus,
  onSalePaddlePrices,
  verifyStorePurchase,
} from '../services/iap';

// IAP routes: the client-facing subscription surface (status/verify/portal, all
// contract-typed in @stxapps/shared) plus the provider webhooks (Paddle, App
// Store, Play Store). Every route carries its own '/v1/…' path, so this sub-app
// mounts at the root in app.ts.

// The webhook paths are NOT shared contracts (their request shapes are the
// providers', and no client of the shared package ever calls them), so they
// live here. Each is registered with its provider per env: Paddle as a
// notification destination, App Store as the App Store Server Notifications V2
// URL (App Store Connect), Play as a Pub/Sub push subscription endpoint on the
// RTDN topic (with `?token=` carrying PLAY_NOTIFY_TOKEN).
export const PADDLE_WEBHOOK_PATH = `${API_V1}/iap/paddle/webhook`;
export const APPSTORE_NOTIFY_PATH = `${API_V1}/iap/appstore/notify`;
export const PLAYSTORE_NOTIFY_PATH = `${API_V1}/iap/playstore/notify`;

// The store verifiers need per-source config (JWT signing keys etc. — see
// lib/env.ts). Checked up front so a missing secret is a clear 500, not a
// garbage outbound request.
function requireStoreConfig(env: Bindings | undefined, source: StoreSource): void {
  const ok =
    source === 'appstore'
      ? env?.APPSTORE_API_BASE &&
        env.APPSTORE_ISSUER_ID &&
        env.APPSTORE_KEY_ID &&
        env.APPSTORE_BUNDLE_ID &&
        env.APPSTORE_PRIVATE_KEY
      : env?.PLAY_PACKAGE_NAME && env?.PLAY_SA_EMAIL && env?.PLAY_SA_PRIVATE_KEY;
  if (!ok) {
    throw new HttpError(500, 'not_configured', `${source} verification is not configured`);
  }
}

export const iapRoutes = new Hono<AppEnv>()
  // --- status — the fold every device reads + caches ------------------------
  // The one caller that passes `refresh`: a stale-looking row gets re-pulled
  // from its provider before folding, which is what makes a webhook that never
  // arrived self-heal (services/iap.ts — staleness refresh). Bounded there by a
  // per-row debounce and a per-read cap, and non-fatal, so an unreachable
  // provider degrades to the stored answer rather than failing the read.
  .get(iapStatusEndpoint.path, requireAuth, async (c) => {
    const body: SubscriptionStatus = await getSubscriptionStatus(c.env, c.get('session').userId, {
      refresh: true,
    });
    return c.json(body);
  })
  // --- prices — the on-sale catalog ids, for the client's price preview -----
  // Pure config read (no DB, no outbound call), so no rate limit beyond the
  // 'standard' baseline. Authenticated only because every route here is and the
  // one caller is behind a session anyway — a `pri_…` is not a secret, and the
  // endpoint cannot move money (see the contract note in @stxapps/shared).
  .get(iapPricesEndpoint.path, requireAuth, (c) => {
    const body: IapPricesResponse = { prices: onSalePaddlePrices(c.env) };
    return c.json(body);
  })
  // --- checkout — create the Paddle transaction the client opens ------------
  .post(
    iapCheckoutEndpoint.path,
    requireAuth,
    // Tight + per-user: every call is an outbound Paddle API request.
    rateLimit('tight', userRateLimitKey),
    zValidator('json', iapCheckoutEndpoint.request),
    async (c) => {
      const { plan } = c.req.valid('json');
      const transactionId = await createPaddleTransaction(c.env, c.get('session').userId, plan);
      const body: IapCheckoutResponse = { transactionId };
      return c.json(body);
    },
  )
  // --- verify — the store-receipt seam (bracemark-expo) -------------------------
  .post(
    iapVerifyEndpoint.path,
    requireAuth,
    // Tight + per-user: every call verifies a receipt against the App Store /
    // Play API (an outbound request).
    rateLimit('tight', userRateLimitKey),
    zValidator('json', iapVerifyEndpoint.request),
    async (c) => {
      const req = c.req.valid('json');
      requireStoreConfig(c.env, req.source);
      const body: SubscriptionStatus = await verifyStorePurchase(
        c.env,
        c.get('session').userId,
        req,
      );
      return c.json(body);
    },
  )
  // --- portal — mint a Paddle customer-portal session URL -------------------
  .post(
    iapPortalEndpoint.path,
    requireAuth,
    // Tight + per-user: every call is an outbound Paddle API request.
    rateLimit('tight', userRateLimitKey),
    async (c) => {
      const url = await createPaddlePortalSession(c.env, c.get('session').userId);
      const body: IapPortalResponse = { url };
      return c.json(body);
    },
  )
  // --- Paddle webhook — server-to-server, HMAC-authenticated ----------------
  // Exempt from the 'standard' baseline (see app.ts); carries the wide 'webhook'
  // tier instead — per-IP, wide enough that real Paddle bursts never 429, tight
  // enough to bound an attacker who finds the URL to cheap signature checks.
  .post(PADDLE_WEBHOOK_PATH, rateLimit('webhook'), async (c) => {
    // No bearer auth: the caller is Paddle, and the Paddle-Signature HMAC over
    // the RAW body (verified below, against the per-destination secret) is the
    // authentication. Read the raw text FIRST — the signature covers those exact
    // bytes, never a re-serialized parse.
    const secret = c.env?.PADDLE_WEBHOOK_SECRET;
    if (!secret) {
      throw new HttpError(500, 'not_configured', 'Paddle webhook secret is not configured');
    }

    const rawBody = await c.req.text();
    const valid = await verifyPaddleSignature(rawBody, c.req.header('Paddle-Signature'), secret);
    if (!valid) {
      throw new HttpError(401, 'invalid_signature', 'Paddle signature verification failed');
    }

    // Past the signature everything is log-and-ACK: a signed event we can't
    // parse or apply is OUR bug or an event type we don't consume — returning
    // non-2xx would just make Paddle redeliver it forever.
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      console.error('paddle webhook: signed body is not JSON');
      return c.json({ ok: true });
    }
    const parsed = paddleEventSchema.safeParse(json);
    if (!parsed.success) {
      console.error('paddle webhook: unexpected event shape', parsed.error.message);
      return c.json({ ok: true });
    }

    await applyPaddleEvent(c.env, parsed.data);
    return c.json({ ok: true });
  })
  // --- store notifications — server-to-server, both call-back-authenticated -
  // Same webhook posture as Paddle (baseline-exempt, 'webhook' tier — see
  // app.ts), but authenticated DIFFERENTLY: the pushed payload is used only to
  // find WHICH subscription changed, and the facts are re-fetched from the
  // store's API (call-back pattern — lib/appstore.ts / lib/playstore.ts), so
  // neither route verifies provider signatures (no x5c chain, no OIDC). A
  // forged POST can only make us re-read the truth, bounded by the rate limit.
  // Past parsing everything is log-and-ACK (both stores redeliver on non-200);
  // the one deliberate non-200 is the store API being unreachable, where a
  // redelivery is exactly right.
  //
  // Play: the Pub/Sub push endpoint for Real-time Developer Notifications.
  .post(PLAYSTORE_NOTIFY_PATH, rateLimit('webhook'), async (c) => {
    // The static `?token=` secret (Google's recommended push-endpoint guard)
    // makes junk rejectable before any outbound work.
    const secret = c.env?.PLAY_NOTIFY_TOKEN;
    if (!secret) {
      throw new HttpError(500, 'not_configured', 'Play notification token is not configured');
    }
    if (c.req.query('token') !== secret) {
      throw new HttpError(401, 'invalid_token', 'Bad push token');
    }
    requireStoreConfig(c.env, 'playstore');

    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      console.error('playstore notify: body is not JSON');
      return c.json({ ok: true });
    }
    const purchaseToken = playNotificationPurchaseToken(json);
    if (!purchaseToken) {
      // Test notifications and one-time-product events land here — expected.
      return c.json({ ok: true });
    }

    await applyStoreNotification(c.env, 'playstore', purchaseToken);
    return c.json({ ok: true });
  })
  // App Store: Server Notifications V2 ({ signedPayload: JWS }).
  .post(APPSTORE_NOTIFY_PATH, rateLimit('webhook'), async (c) => {
    requireStoreConfig(c.env, 'appstore');

    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      console.error('appstore notify: body is not JSON');
      return c.json({ ok: true });
    }
    const signedPayload =
      typeof json === 'object' && json !== null && 'signedPayload' in json
        ? (json as { signedPayload: unknown }).signedPayload
        : null;
    if (typeof signedPayload !== 'string') {
      console.error('appstore notify: no signedPayload');
      return c.json({ ok: true });
    }

    const transactionId = appstoreNotificationTransactionId(signedPayload);
    if (!transactionId) {
      // Notification types without a transaction (e.g. the TEST ping App Store
      // Connect sends when registering the URL) land here — expected.
      return c.json({ ok: true });
    }

    await applyStoreNotification(c.env, 'appstore', transactionId);
    return c.json({ ok: true });
  });
