import { z } from 'zod';

import { base64UrlToBytes, bytesToBase64Url, bytesToUtf8 } from '@stxapps/shared';

import type { PurchaseStatus } from '../db/repositories/purchases';
import type { Bindings } from './env';
import { b64urlEncodeJson, pemToPkcs8 } from './jwt';
import type { StoreSubscriptionSnapshot } from './store';

// App Store provider-vocab edge — the `lib/paddle.ts` sibling for Apple.
// Everything App-Store-shaped (the Server API JWT, the subscription-status
// fetch, JWS payload decoding, status normalization) lives here so
// services/iap.ts only ever sees normalized statuses and epoch-ms times.
//
// TRUST MODEL — the call-back pattern. Nothing a client or a notification
// carries is ever applied directly: the token is only a LOOKUP KEY, and the
// facts (productId, status, expiry) come from a fresh server-to-server fetch of
// `GET /inApps/v1/subscriptions/{transactionId}` on Apple's App Store Server
// API over TLS. That is why the JWS blobs in the response are decoded WITHOUT
// x5c chain verification — we just fetched them from Apple directly, so TLS to
// the pinned hostname is the authentication (chain verification exists for
// payloads that arrive via an untrusted hop, and our notification route
// deliberately re-fetches instead of trusting its payload — see
// applyAppstoreNotification in services/iap.ts). A forged token can only make
// us fetch a subscription that doesn't exist (404 → invalid_receipt) or one
// bound to another account (the repo's first-write-wins binding holds).

// The Server API hosts. Which one an env uses is config (APPSTORE_API_BASE:
// sandbox for development/staging, production for production) — but production
// ALSO falls back to sandbox on a not-found: App Review purchases with sandbox
// accounts against the production build, and Apple's guidance is exactly this
// production-first-then-sandbox retry.
export const APPSTORE_PRODUCTION_API_BASE = 'https://api.storekit.itunes.apple.com';
export const APPSTORE_SANDBOX_API_BASE = 'https://api.storekit-sandbox.itunes.apple.com';

// --- JWS payload decoding ---------------------------------------------------

// Decode a JWS compact serialization's PAYLOAD without verifying its signature.
// Safe ONLY for payloads we fetched from Apple over TLS ourselves (see the
// trust-model note above) — never for anything that arrived from outside.
// Returns null instead of throwing on a malformed blob (log-and-drop callers).
export function decodeJwsPayload(jws: string): unknown | null {
  const parts = jws.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(bytesToUtf8(base64UrlToBytes(parts[1])));
  } catch {
    return null;
  }
}

// --- the Server API JWT (ES256) ---------------------------------------------

// How long a minted Server API token stays valid. Apple's ceiling is 60 min; 5
// keeps the blast radius small, and nothing here wants more — the token is
// signed immediately before the call it authorizes, so this only has to cover
// clock skew against Apple. (The Play sibling's PLAY_ASSERTION_TTL_SECONDS is
// the same idea, though what it signs is an assertion TRADED for a token rather
// than the credential itself — see lib/playstore.ts.)
const APPSTORE_JWT_TTL_SECONDS = 5 * 60;

// Mint the short-lived App Store Server API token: an ES256 JWT signed with the
// In-App Purchase key (App Store Connect → Users and Access → Integrations),
// whose PKCS#8 PEM is the APPSTORE_PRIVATE_KEY secret. Minted per call, and
// deliberately NOT cached the way the Play access token is: this is a local
// ES256 signature — sub-millisecond, no network — so minting it every time is
// free, and a cache could only add a staleness surface. Play's costs a round
// trip to Google, which is the whole reason that one is worth caching.
export async function appstoreApiJwt(env: Bindings, now: number = Date.now()): Promise<string> {
  const header = { alg: 'ES256', kid: env.APPSTORE_KEY_ID, typ: 'JWT' };
  const iat = Math.floor(now / 1000);
  const payload = {
    iss: env.APPSTORE_ISSUER_ID,
    iat,
    exp: iat + APPSTORE_JWT_TTL_SECONDS,
    aud: 'appstoreconnect-v1',
    bid: env.APPSTORE_BUNDLE_ID,
  };

  const signingInput = `${b64urlEncodeJson(header)}.${b64urlEncodeJson(payload)}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(env.APPSTORE_PRIVATE_KEY),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  // WebCrypto ECDSA emits the raw r||s form JWS wants (no DER re-packing needed).
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${bytesToBase64Url(sig)}`;
}

// --- the subscription-status fetch + normalization --------------------------

// The slices of the two JWS payloads we consume (permissive like
// paddleEventSchema — Apple adds fields freely).
const transactionInfoSchema = z.looseObject({
  productId: z.string(),
  originalTransactionId: z.string(),
  expiresDate: z.number().optional(), // epoch ms
  // epoch ms; present when Apple refunded the transaction or revoked it from
  // Family Sharing — entitlement ends HERE, not at expiresDate (see the clamp).
  revocationDate: z.number().optional(),
  offerDiscountType: z.string().nullish(), // 'FREE_TRIAL' | 'PAY_AS_YOU_GO' | …
});

const renewalInfoSchema = z.looseObject({
  autoRenewStatus: z.number().optional(), // 1 = will renew, 0 = user turned it off
  // epoch ms; present while a lapsed subscription is inside the billing grace
  // period CONFIGURED in App Store Connect (up to 28 days) — Apple's own
  // entitled-through date for status 4.
  gracePeriodExpiresDate: z.number().optional(),
});

const statusResponseSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      lastTransactions: z.array(
        z.looseObject({
          originalTransactionId: z.string(),
          status: z.number(),
          signedTransactionInfo: z.string(),
          signedRenewalInfo: z.string().optional(),
        }),
      ),
    }),
  ),
});

// Apple's subscription status codes → our vocabulary. Explicit map like
// PADDLE_STATUS_MAP: an unknown code comes back null (→ log + drop), never
// flows into the fold.
//  1 active, 2 expired, 3 expired-in-billing-retry, 4 billing grace period,
//  5 revoked (family-sharing revocation / refund).
// 3 maps to past_due: the fold's PAST_DUE_GRACE_MS (16 days past expiry) is the
// product decision on how long dunning stays entitled — tighter than Apple's
// 60-day retry window, same posture as Paddle dunning. 4 also honors Apple's
// own gracePeriodExpiresDate as the period end (the clamp below). 2 and 5 map
// to canceled: the row records WHY it ended, the fold decides entitlement from
// time — for 2 the expiry is already past; for 5 (refund / Family Sharing
// revocation) expiresDate keeps the originally paid-through date, so the
// snapshot clamps it to revocationDate — a refund must not keep entitling.
const APPSTORE_STATUS_MAP: Record<number, PurchaseStatus> = {
  1: 'active',
  2: 'canceled',
  3: 'past_due',
  4: 'past_due',
  5: 'canceled',
};

// Fetch + normalize the subscription a transaction id belongs to. Null when the
// id resolves to nothing (a forged/garbage token) or the response carries no
// transaction for a product we recognize the shape of — callers decide whether
// that's a 422 (verify) or a log-and-drop (notification).
export async function fetchAppstoreSubscription(
  env: Bindings,
  transactionId: string,
): Promise<StoreSubscriptionSnapshot | null> {
  // The id is interpolated into the URL path — reject anything that could
  // change the path shape before it reaches fetch (ids are digits, but Apple
  // only promises a string; being strict here costs nothing).
  if (!/^[A-Za-z0-9._-]+$/.test(transactionId)) return null;

  const jwt = await appstoreApiJwt(env);
  const lookup = (base: string) =>
    fetch(`${base}/inApps/v1/subscriptions/${transactionId}`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });

  let res = await lookup(env.APPSTORE_API_BASE);
  // Production-first-then-sandbox: App Review runs sandbox purchases against
  // the production build, whose config points at the production host.
  if (res.status === 404 && env.APPSTORE_API_BASE === APPSTORE_PRODUCTION_API_BASE) {
    res = await lookup(APPSTORE_SANDBOX_API_BASE);
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    console.error(`fetchAppstoreSubscription: App Store Server API ${res.status}`);
    throw new Error(`App Store Server API ${res.status}`);
  }

  const parsed = statusResponseSchema.safeParse(await res.json());
  if (!parsed.success) {
    console.error('fetchAppstoreSubscription: unexpected response shape', parsed.error.message);
    return null;
  }

  // One subscription group in practice (all our plans share one group so
  // upgrades are proper StoreKit crossgrades) — but the response spans EVERY
  // group, so prefer the transaction whose originalTransactionId matches the
  // looked-up id; with a second group, "the first parseable" would be an
  // arbitrary subscription. The fallback covers the common case where the app
  // sent a LATER transaction id of the same subscription.
  let fallback: StoreSubscriptionSnapshot | null = null;
  for (const group of parsed.data.data) {
    for (const last of group.lastTransactions) {
      const status = APPSTORE_STATUS_MAP[last.status] ?? null;
      if (status === null) {
        console.error(`fetchAppstoreSubscription: unknown status code ${last.status}`);
        continue;
      }

      const info = transactionInfoSchema.safeParse(decodeJwsPayload(last.signedTransactionInfo));
      if (!info.success) {
        console.error('fetchAppstoreSubscription: bad signedTransactionInfo payload');
        continue;
      }
      const renewal = last.signedRenewalInfo
        ? renewalInfoSchema.safeParse(decodeJwsPayload(last.signedRenewalInfo))
        : null;

      let expiresAt = info.data.expiresDate ?? null;
      // Billing grace period (status 4): Apple keeps the user entitled through
      // the grace window configured in App Store Connect, and renewalInfo
      // carries its end — honor it as the period end. The fold's own past_due
      // slack then runs past what Apple last promised, the same posture as
      // Paddle dunning.
      const graceEndsAt = renewal?.success ? (renewal.data.gracePeriodExpiresDate ?? null) : null;
      if (status === 'past_due' && graceEndsAt !== null) {
        expiresAt = Math.max(expiresAt ?? graceEndsAt, graceEndsAt);
      }
      // Revocation (refund / Family Sharing revocation): entitlement ends at
      // revocationDate, but expiresDate keeps the originally paid-through date
      // — an annual plan refunded in month one would otherwise go on entitling
      // for eleven more months. Clamp.
      if (info.data.revocationDate !== undefined) {
        expiresAt = Math.min(expiresAt ?? info.data.revocationDate, info.data.revocationDate);
      }

      // Auto-renew off while still entitled is Apple's "scheduled cancel" —
      // record it like Paddle's scheduled_change (canceledAt = period end) so
      // willRenew folds false; null CLEARS it when the user resumes.
      const willRenew =
        status === 'active' || status === 'past_due'
          ? (renewal?.success ? renewal.data.autoRenewStatus : undefined) === 1
          : false;
      // 'trialing' is a display distinction only (the fold treats it as
      // active); Apple's status codes have no trial value — code 1 is plain
      // "active" whether or not an intro offer applies — so the signal is the
      // transaction's offer type. FREE_TRIAL exactly: PAY_AS_YOU_GO and
      // PAY_UP_FRONT are DISCOUNTED intro offers, where the user has already
      // been charged and "renews on" is the truthful sentence.
      //
      // Nothing has to un-set this: Apple mints a NEW transaction for the first
      // paid period and `lastTransactions` returns the latest, so the offer
      // fields simply aren't there once the trial converts. Play needs a
      // deliberate guard for the same transition (lib/playstore.ts,
      // PLAY_FREE_TRIAL_OFFER_TAG) because it reuses one line item across it.
      const effectiveStatus: PurchaseStatus =
        status === 'active' && info.data.offerDiscountType === 'FREE_TRIAL' ? 'trialing' : status;

      // The snapshot's two optional fields are Play-only and stay unset: Apple
      // has no acknowledge concept, and no linked-purchase analogue either —
      // originalTransactionId survives a plan change within a subscription
      // group, so an upgrade updates this identity instead of minting a second.
      const snapshot: StoreSubscriptionSnapshot = {
        externalId: info.data.originalTransactionId,
        productId: info.data.productId,
        status: effectiveStatus,
        expiresAt,
        canceledAt: willRenew ? null : expiresAt,
      };
      if (info.data.originalTransactionId === transactionId) return snapshot;
      fallback ??= snapshot;
    }
  }
  return fallback;
}

// The slice of an App Store Server Notification V2 we consume: just enough to
// find WHICH subscription changed. The payload is deliberately NOT trusted for
// facts — the service re-fetches authoritative state from Apple (call-back
// pattern), so this needs no x5c chain verification. Returns the transaction id
// to look up, or null (→ log-and-ACK).
export function appstoreNotificationTransactionId(signedPayload: string): string | null {
  const payload = z
    .looseObject({
      data: z
        .looseObject({
          signedTransactionInfo: z.string().optional(),
        })
        .optional(),
    })
    .safeParse(decodeJwsPayload(signedPayload));
  if (!payload.success || !payload.data.data?.signedTransactionInfo) return null;

  const info = transactionInfoSchema
    .pick({ originalTransactionId: true })
    .safeParse(decodeJwsPayload(payload.data.data.signedTransactionInfo));
  return info.success ? info.data.originalTransactionId : null;
}
