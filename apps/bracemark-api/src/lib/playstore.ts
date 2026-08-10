import { z } from 'zod';

import { bytesToBase64Url } from '@stxapps/shared';

import type { PurchaseStatus } from '../db/repositories/purchases';
import type { Bindings } from './env';
import { b64urlEncodeJson, pemToPkcs8 } from './jwt';
import type { StoreSubscriptionSnapshot } from './store';

// Play Store provider-vocab edge — the `lib/paddle.ts` sibling for Google.
// Everything Play-shaped (the service-account OAuth token, the subscriptionsv2
// fetch, RTDN decoding, state normalization) lives here so services/iap.ts only
// ever sees normalized statuses and epoch-ms times.
//
// Same call-back trust model as lib/appstore.ts: the purchase token — whether
// it arrives from the app's `iap/verify` or a Pub/Sub push — is only a LOOKUP
// KEY; the facts come from a fresh server-to-server fetch of
// `purchases.subscriptionsv2.get` on the Play Developer API. A forged token
// fetches nothing (404 → invalid_receipt); a forged Pub/Sub push can only make
// us re-read the truth.

// A module CONSTANT, not a per-env binding like APPSTORE_API_BASE — and there is
// no production-first-then-sandbox retry here, because Google ships no sandbox
// host to retry against. The Play Developer API has exactly ONE host: a license
// tester's test purchase, an internal/closed-track purchase, and a real paid
// purchase all resolve through this same URL under the same package name, and
// Google marks the difference in the RESPONSE BODY (`testPurchase` on
// SubscriptionPurchaseV2) rather than by endpoint. Same for RTDNs — test
// notifications arrive on the same Pub/Sub topic (and drop out of
// playNotificationPurchaseToken as `testNotification`). So a 404 from Play means
// the token genuinely doesn't exist and the null below is the whole answer;
// Apple's fallback exists only because a sandbox transaction id is invisible to
// the production host (see lib/appstore.ts). Play's per-env dimension is the
// package name + service account, which are bindings.
const PLAY_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PLAY_API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

// Lifetime of the ASSERTION signed for the token exchange — NOT of the access
// token Google returns (that's `expires_in`, and the margin below). It's
// consumed once, immediately, so this only has to cover clock skew between us
// and Google; Google rejects an assertion whose exp is over an hour out, and
// short is strictly better anyway — nothing is gained by widening the replay
// window on a credential that goes on the wire.
const PLAY_ASSERTION_TTL_SECONDS = 5 * 60;

// Refresh this far before Google's stated expiry, so a token handed out at the
// edge of the window can't lapse mid-flight on the call it was fetched for.
// Deliberately NOT shared with the assertion TTL above: this one is a haircut
// on a lifetime GOOGLE chooses, so the two have no reason to move together.
const PLAY_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// The cached access token. Isolate-scoped by construction: a Workers isolate
// serves many requests before eviction and module state outlives each one, so
// this is shared across requests — deliberately (see playAccessToken), and
// safely, because the token carries NO request or user dimension.
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

// Drop the cached token. Production calls this on a 401 (see playApiFetch); it
// is also the specs' seam, since module state outlives a single test in the
// same file and each one scripts its own token exchange.
export function resetPlayAccessTokenCache(): void {
  cachedAccessToken = null;
}

// Service-account access token via the OAuth2 JWT-bearer flow: an RS256 JWT
// signed with the service account's key (the PLAY_SA_PRIVATE_KEY secret —
// PKCS#8 PEM, the `private_key` field of the downloaded JSON), exchanged at
// Google's token endpoint.
//
// CACHED in the isolate, unlike the App Store JWT — the two look alike but cost
// nothing alike. Apple's is a local ES256 signature (sub-ms, no network), so
// minting it per call is free and caching would only add staleness. This one is
// a round trip to Google on the critical path of every Play operation, and the
// operations amplify: a verify that acknowledges needs two (the subscriptionsv2
// fetch, then the `:acknowledge` POST), and the staleness refresh adds one per
// Play row it re-pulls. Google's tokens live an hour and their own guidance is
// to reuse them.
//
// The token is per SERVICE ACCOUNT — its claims name PLAY_SA_EMAIL and the
// androidpublisher scope, never a user — so one token is valid for every
// lookup, and sharing it across requests leaks nothing between accounts. What
// caching does NOT do is scale with user count: a warm isolate is the only
// thing it rides on, and Cloudflare spreads traffic over many isolates across
// many colos, evicting idle ones. Hit rate therefore tracks traffic
// CONCENTRATION per isolate, not headcount; a cold isolate simply mints again,
// which is the correct floor rather than a failure.
//
// Two constraints shape the implementation:
//   - Cache the resolved STRING, never the in-flight promise. Awaiting a
//     promise created during another request's context throws "Cannot perform
//     I/O on behalf of a different request", so concurrent cold requests each
//     mint their own — no cross-request single-flight is possible here.
//   - In memory only, never KV or the Cache API: those would put a live
//     credential outside the isolate for a marginal hit-rate gain.
export async function playAccessToken(env: Bindings, now: number = Date.now()): Promise<string> {
  if (cachedAccessToken && now < cachedAccessToken.expiresAt) return cachedAccessToken.token;

  const iat = Math.floor(now / 1000);
  const claims = {
    iss: env.PLAY_SA_EMAIL,
    scope: PLAY_SCOPE,
    aud: PLAY_TOKEN_URL,
    iat,
    exp: iat + PLAY_ASSERTION_TTL_SECONDS,
  };
  const signingInput = `${b64urlEncodeJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlEncodeJson(claims)}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(env.PLAY_SA_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput)),
  );
  const assertion = `${signingInput}.${bytesToBase64Url(sig)}`;

  const res = await fetch(PLAY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    console.error(`playAccessToken: token endpoint ${res.status}`);
    throw new Error(`Play token endpoint ${res.status}`);
  }
  const body = z
    .looseObject({ access_token: z.string(), expires_in: z.number().optional() })
    .safeParse(await res.json());
  if (!body.success) {
    console.error('playAccessToken: no access_token in response');
    throw new Error('Play token endpoint: malformed response');
  }

  // Cache only on Google's own `expires_in` (3600 in practice), and only when
  // it outlasts the margin — an absent or implausibly short lifetime means mint
  // per call rather than guess at one. Measured from `now` (request start)
  // rather than after the round trip, so the window can only be conservative.
  const ttlMs = (body.data.expires_in ?? 0) * 1000;
  if (ttlMs > PLAY_TOKEN_REFRESH_MARGIN_MS) {
    cachedAccessToken = {
      token: body.data.access_token,
      expiresAt: now + ttlMs - PLAY_TOKEN_REFRESH_MARGIN_MS,
    };
  }
  return body.data.access_token;
}

// One authorized Play Developer API call, retried ONCE on a 401.
//
// The refresh margin above handles the expiry Google announced; it can't handle
// a credential that dies EARLY — a rotated service-account key, or the account
// losing API access — which leaves the isolate holding a token Google no longer
// honors. Without this, every caller sharing that isolate fails for the rest of
// the window (up to ~55 min), and a notification redelivery lands right back on
// the same dead token, so the usual self-healing never gets a chance.
//
// Exactly once: a second 401 is a real auth problem (wrong key, revoked access)
// rather than staleness, and retrying that only doubles outbound traffic on a
// broken config — so it's logged and returned for the caller to treat as the
// failure it is.
async function playApiFetch(
  env: Bindings,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  const send = (token: string) =>
    fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });

  const token = await playAccessToken(env);
  const res = await send(token);
  if (res.status !== 401) return res;

  // Only clear when the cache still holds the token that just failed: a
  // concurrent request may already have replaced it, and dropping that fresh
  // one would make every 401 in flight mint yet another.
  if (cachedAccessToken?.token === token) resetPlayAccessTokenCache();

  const retried = await send(await playAccessToken(env));
  if (retried.status === 401) {
    console.error('playApiFetch: 401 from the Play Developer API after a fresh token');
  }
  return retried;
}

// The slice of a SubscriptionPurchaseV2 we consume (permissive — Google adds
// fields freely).
const subscriptionV2Schema = z.looseObject({
  subscriptionState: z.string(),
  // ACKNOWLEDGEMENT_STATE_PENDING until the purchase is acknowledged — the
  // flag the acknowledge retry keys on (needsAcknowledge on the return below).
  acknowledgementState: z.string().optional(),
  // Set when this purchase REPLACED an earlier one — see the supersession note
  // on the return below.
  linkedPurchaseToken: z.string().optional(),
  lineItems: z.array(
    z.looseObject({
      productId: z.string(),
      expiryTime: z.string().optional(), // RFC 3339
      autoRenewingPlan: z.looseObject({ autoRenewEnabled: z.boolean().optional() }).nullish(),
      // Present while a non-base-plan OFFER applies to this line — the only
      // place a free trial is visible on Play (see PLAY_FREE_TRIAL_OFFER_TAG).
      offerDetails: z
        .looseObject({
          offerId: z.string().optional(),
          offerTags: z.array(z.string()).optional(),
        })
        .nullish(),
    }),
  ),
});

// The Play Console OFFER TAG that marks our free-trial offer.
//
// Play has no trial STATUS: a subscription inside its trial phase reads
// SUBSCRIPTION_STATE_ACTIVE like any other, and v1's `paymentState: 2` ("free
// trial") did not survive into subscriptionsv2. The offer applied to the line
// item is the only signal — and `offerId` alone won't do, since a paid
// introductory offer carries one too (Apple's PAY_AS_YOU_GO/PAY_UP_FRONT
// problem, same shape). A TAG rather than an id also means regional or
// campaign-specific trial offers all share one marker, so adding an offer in
// Play Console never needs a deploy here.
//
// TAG THE OFFER, NEVER THE BASE PLAN. `offerTags` includes tags INHERITED from
// the base plan, so a base-plan tag would mark every Android subscriber
// `trialing` forever — and nothing would ever clear it. Play is the only
// provider where that's possible: Paddle's own status flips trialing→active,
// and Apple mints a FRESH transaction for the first paid period (dropping
// offerDiscountType with it), but Play carries ONE line item across the
// trial→paid boundary. So the launch checklist item is to watch a license
// tester — whose trial and renewal periods are compressed to minutes — cross
// that boundary and confirm the tag is gone (docs/iap.md, the trial).
export const PLAY_FREE_TRIAL_OFFER_TAG = 'free-trial';

// Play's subscriptionState → our vocabulary. Explicit map like
// PADDLE_STATUS_MAP: an unknown/new state comes back null (→ log + drop).
//  - IN_GRACE_PERIOD is Google's still-entitled dunning window → past_due.
//  - ON_HOLD is dunning where Google says the entitlement is REVOKED, so it
//    must not ride the fold's past_due grace → paused (never entitled).
//  - CANCELED means auto-renew off, entitled until expiry — exactly our
//    canceled semantics; EXPIRED is the same row with the expiry in the past.
//  - PENDING purchases haven't been paid → null (drop until a real state).
//  - PENDING_PURCHASE_CANCELED is a pending purchase that never completed —
//    also never entitled, and listed explicitly so it takes the quiet null path
//    instead of logging "unmapped state" on every delivery.
const PLAY_STATE_MAP: Record<string, PurchaseStatus | null> = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'past_due',
  SUBSCRIPTION_STATE_ON_HOLD: 'paused',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_CANCELED: 'canceled',
  SUBSCRIPTION_STATE_EXPIRED: 'canceled',
  SUBSCRIPTION_STATE_PENDING: null,
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: null,
};

// Fetch + normalize the subscription a purchase token identifies. Null when the
// token resolves to nothing or to a state/shape we don't consume — callers
// decide 422 (verify) vs log-and-ACK (notification).
export async function fetchPlaystoreSubscription(
  env: Bindings,
  purchaseToken: string,
): Promise<StoreSubscriptionSnapshot | null> {
  // The token is interpolated into the URL path; Play tokens are URL-safe
  // base64-ish, so anything outside that alphabet is garbage.
  if (!/^[A-Za-z0-9._-]+$/.test(purchaseToken)) return null;

  const res = await playApiFetch(
    env,
    `${PLAY_API_BASE}/applications/${env.PLAY_PACKAGE_NAME}/purchases/subscriptionsv2/tokens/${purchaseToken}`,
  );
  // Garbage/forged tokens come back 400 ("Invalid Value") or 404 from Google.
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) {
    console.error(`fetchPlaystoreSubscription: Play Developer API ${res.status}`);
    throw new Error(`Play Developer API ${res.status}`);
  }

  const parsed = subscriptionV2Schema.safeParse(await res.json());
  if (!parsed.success) {
    console.error('fetchPlaystoreSubscription: unexpected response shape', parsed.error.message);
    return null;
  }

  const status = PLAY_STATE_MAP[parsed.data.subscriptionState] ?? null;
  if (status === null) {
    console.error(`fetchPlaystoreSubscription: unmapped state "${parsed.data.subscriptionState}"`);
    return null;
  }

  const [first] = parsed.data.lineItems;
  if (!first) {
    console.error('fetchPlaystoreSubscription: no line items');
    return null;
  }
  // Normally one line item, but a deferred plan change can carry two — the
  // expiring current item and the incoming one. Take the line with the LATEST
  // expiry (the one that governs where the subscription is headed); [0] would
  // be order-of-response luck.
  let line = first;
  for (const candidate of parsed.data.lineItems) {
    if (
      (playTimeToMs(candidate.expiryTime) ?? -Infinity) >
      (playTimeToMs(line.expiryTime) ?? -Infinity)
    ) {
      line = candidate;
    }
  }

  const expiresAt = playTimeToMs(line.expiryTime);
  const willRenew =
    (status === 'active' || status === 'past_due') &&
    line.autoRenewingPlan?.autoRenewEnabled === true;

  // 'trialing' is a display distinction only (the fold treats it as active) —
  // the sibling of lib/appstore.ts's effectiveStatus, keyed on Play's offer tag
  // instead of Apple's offerDiscountType. Gated on 'active' for the same reason
  // it is there: the offer is still on the line item while a lapsed trial
  // dunning in IN_GRACE_PERIOD, and that user is owed the past_due sentence
  // ("your payment didn't go through"), not the trial one.
  const effectiveStatus: PurchaseStatus =
    status === 'active' && line.offerDetails?.offerTags?.includes(PLAY_FREE_TRIAL_OFFER_TAG)
      ? 'trialing'
      : status;

  return {
    // The purchase token is the stable identity of one subscription instance —
    // the Play analogue of Paddle's sub_… id. Note "instance", not
    // "subscription": unlike Paddle's sub_… and Apple's originalTransactionId,
    // which survive a plan change, Play RE-KEYS on one (see linkedExternalId).
    externalId: purchaseToken,
    productId: line.productId,
    status: effectiveStatus,
    expiresAt,
    canceledAt: willRenew ? null : expiresAt,
    // The token this purchase REPLACED, when it replaced one. Play mints a new
    // token — a new identity, so a new row — for an upgrade/downgrade, for a
    // re-signup of a canceled-but-not-yet-lapsed subscription, and for the
    // prepaid conversions; `linkedPurchaseToken` on the new record points back
    // at the old one.
    //
    // Google does NOT reliably retire the old token for us: it goes on
    // resolving through this same endpoint with its ORIGINAL period, so a
    // refetch can't discover that it died and the staleness backstop
    // (services/iap.ts needsRefresh) never even looks at a row that still reads
    // active with a future expiry. Retiring it is the server's job, which
    // services/iap.ts supersedeLinkedPlayPurchase does — without it a downgrade
    // leaves the higher-plan row entitled (the fold takes the best plan), and a
    // re-signup under a second account leaves BOTH accounts entitled on one
    // payment.
    linkedExternalId: parsed.data.linkedPurchaseToken ?? null,
    // Still unacknowledged at Google — the 3-day auto-refund fuse is burning.
    // Surfacing the store's own flag (rather than "is this a verify?") is what
    // lets EVERY path that records the entitlement retry the acknowledge until
    // Google confirms it — see acknowledgePlaystorePurchase below.
    needsAcknowledge: parsed.data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING',
  };
}

// ACKNOWLEDGE a new Play purchase — the only hard DEADLINE anywhere in the IAP
// design. Google auto-refunds and REVOKES an initial subscription purchase that
// goes unacknowledged for 3 days (renewals are exempt). Apple has no equivalent:
// StoreKit's finishTransaction is client-only and an unfinished transaction is
// simply redelivered forever, which is why this has no appstore sibling.
//
// The app already satisfies the requirement — expo-iap's
// `finishTransaction({ isConsumable: false })` acknowledges on Android — and
// that call is deliberately deferred until THIS server has recorded the
// purchase (docs/iap.md, the store purchase flow), which is what makes an
// unfinished transaction a free retry. On iOS that retry is unbounded; on
// Android it runs against the 3-day fuse. So the server acknowledges too, the
// moment the entitlement is recorded: a client that dies between `iap/verify`
// returning and `finishTransaction` no longer risks a silent revoke. It does
// NOT replace the client call — that's still what stops the store replaying the
// transaction — and acknowledging twice is harmless.
//
// Callers gate on the snapshot's `needsAcknowledge` (Google's own
// acknowledgementState), which buys two things: a restore — whose purchase was
// acknowledged long ago — makes no call at all, and the acknowledge is
// CONVERGENT rather than fire-once: the purchase RTDN and the staleness
// refresh re-check the same flag when they re-fetch a recorded purchase
// (services/iap.ts applyStoreNotification), so even both purchase-time
// acknowledgements failing (this one 5xx-ing AND the client dying before
// finishTransaction) is healed by the next event or refresh that touches the
// row inside the 3-day window.
//
// Note this is the v1 `purchases.subscriptions` endpoint: `subscriptionsv2` is
// query-only, and acknowledge never moved to it.
//
// Returns whether Google accepted the acknowledgement. Every 4xx is swallowed
// — no 4xx here gets better on a retry, and the client's own acknowledgement
// remains the primary path — but they are not all the same event, so they log
// differently:
//   - 401/403 mean the CREDENTIAL is wrong (a rotated-away key, a service
//     account without "View financial data", the app not linked). playApiFetch
//     has already retried a 401 with a freshly minted token, so reaching here
//     is a config failure that NOTHING in the convergent retry can heal — the
//     RTDN and the staleness refresh will hit the same wall. Logged as an error.
//   - Any other 4xx is the expected race: "already acknowledged", from the
//     client's finishTransaction landing between our fetch and this call.
//     Logged quietly, since it means the deadline was met by the other path.
// Only a 5xx/network failure throws, and even that is caught by the caller.
export async function acknowledgePlaystorePurchase(
  env: Bindings,
  productId: string,
  purchaseToken: string,
): Promise<boolean> {
  // Both are interpolated into the URL path — same guard as the fetch above.
  if (!/^[A-Za-z0-9._-]+$/.test(productId)) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(purchaseToken)) return false;

  const res = await playApiFetch(
    env,
    `${PLAY_API_BASE}/applications/${env.PLAY_PACKAGE_NAME}/purchases/subscriptions/${productId}/tokens/${purchaseToken}:acknowledge`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  if (res.ok) return true; // 204 No Content
  if (res.status === 401 || res.status === 403) {
    console.error(
      `acknowledgePlaystorePurchase: Play API ${res.status} — the service-account credential is not usable`,
    );
    return false;
  }
  if (res.status < 500) {
    console.log(`acknowledgePlaystorePurchase: Play API ${res.status} (already acknowledged?)`);
    return false;
  }
  console.error(`acknowledgePlaystorePurchase: Play Developer API ${res.status}`);
  throw new Error(`Play Developer API ${res.status}`);
}

// RFC 3339 → epoch ms, null for absent/unparseable (paddleTimeToMs's sibling).
export function playTimeToMs(rfc3339: string | null | undefined): number | null {
  if (!rfc3339) return null;
  const ms = Date.parse(rfc3339);
  return Number.isFinite(ms) ? ms : null;
}

// Decode a Real-time Developer Notification out of its Pub/Sub push envelope:
// the POST body carries `message.data` = base64(JSON DeveloperNotification).
// Only subscription notifications carry a purchaseToken to look up; test
// notifications and one-time-product events return null (→ log-and-ACK).
export function playNotificationPurchaseToken(pushBody: unknown): string | null {
  const envelope = z
    .looseObject({ message: z.looseObject({ data: z.string() }) })
    .safeParse(pushBody);
  if (!envelope.success) return null;

  let notification: unknown;
  try {
    notification = JSON.parse(atob(envelope.data.message.data));
  } catch {
    return null;
  }
  const parsed = z
    .looseObject({
      subscriptionNotification: z.looseObject({ purchaseToken: z.string() }).optional(),
    })
    .safeParse(notification);
  if (!parsed.success) return null;
  return parsed.data.subscriptionNotification?.purchaseToken ?? null;
}
