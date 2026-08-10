import { z } from 'zod';

import { API_V1, defineEndpoint } from '../api/endpoint';
import { AVAILABLE_PAID_PLANS, PLANS } from './plans';

// IAP endpoint contracts. Subscription state is a SERVER-DERIVED fact (its
// writer of record is a payment-provider webhook), so it is deliberately NOT a
// synced entity in sync/entities.ts: the server can't write into the user's
// encrypted keyspace, and a client-authored copy would be an unverifiable, stale
// echo racing itself under LWW. Every device instead asks bracemark-api — the one
// authority — via `iap/status` and caches the answer locally. See
// iap/plans.ts for what a plan unlocks.
//
// The Paddle WEBHOOK route (`/v1/iap/paddle/webhook`) has no contract here on
// purpose: its request shape is Paddle's, not ours, and no client of this
// package ever calls it — it lives only in bracemark-api.

// Where a subscription was purchased. 'manual' is a server-side grant (comps,
// lifetime deals) with no external provider to verify against.
export const SUBSCRIPTION_SOURCES = ['paddle', 'appstore', 'playstore', 'manual'] as const;
export type SubscriptionSource = (typeof SUBSCRIPTION_SOURCES)[number];

// The account's folded subscription state — what `iap/status` returns and every
// client caches. `plan` is what the client feeds `entitlementsOf()`; the rest is
// display state for the subscription settings UI.
//
// `status`: 'none' = no live subscription (plan is then 'free'); 'active' = paid
// and in good standing; 'trialing' = inside the free trial, fully entitled but
// NOT yet charged; 'grace' = payment trouble (past_due) but still entitled
// while the provider retries — the UI should surface "update your payment
// method" without yanking features mid-dunning.
//
// 'trialing' is carried separately from 'active' because the two owe the user
// different sentences. Entitlement-wise they are identical (a trialing account
// gets exactly `plan`, which is why entitlementsOf takes only the plan), so it
// would be easy to collapse them — but then a user 3 days into a 14-day trial
// reads "Renews on <date>" with no hint that the date is their FIRST charge.
// Saying so is both the honest thing and the thing EU/UK distance-selling rules
// assume was said.
export const subscriptionStatusSchema = z.object({
  plan: z.enum(PLANS),
  status: z.enum(['none', 'active', 'trialing', 'grace']),
  source: z.enum(SUBSCRIPTION_SOURCES).nullable(),
  // Epoch ms the current paid period runs to; null when free or non-expiring
  // (a lifetime/manual grant).
  expiresAt: z.number().int().nullable(),
  // False once the user has canceled (still entitled until expiresAt, but the
  // subscription won't renew) — drives "expires on …" vs "renews on …" copy.
  willRenew: z.boolean(),
});
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

// GET /v1/iap/status → SubscriptionStatus (authenticated)
// The single truth every device reads. Cheap (one indexed D1 read), so clients
// refetch on app start and after a checkout completes (webhooks lag checkout by
// seconds — poll this with a short retry until the plan flips).
export const iapStatusEndpoint = defineEndpoint({
  method: 'GET',
  path: `${API_V1}/iap/status`,
  request: z.object({}),
  response: subscriptionStatusSchema,
});

// POST /v1/iap/checkout → { transactionId } (authenticated)
// Creates a Paddle transaction server-side and returns its id for the client to
// open in the overlay checkout (`Paddle.Checkout.open({ transactionId })`).
// Server-created for two reasons: the client never knows its own userId (the
// account model mints it server-side, so the webhook's `custom_data.userId`
// binding must be stamped by the server from the session), and it keeps the
// purchased price server-authoritative rather than a client-supplied price id.
// Only plans currently ON SALE are accepted (AVAILABLE_PAID_PLANS, not the full
// PAID_PLANS catalog): the wire contract itself rejects a checkout for a
// not-yet-sold plan, so Pro can stay fully specified without being purchasable.
export const iapCheckoutRequestSchema = z.object({
  plan: z.enum(AVAILABLE_PAID_PLANS),
});
export type IapCheckoutRequest = z.infer<typeof iapCheckoutRequestSchema>;

export const iapCheckoutResponseSchema = z.object({
  // Paddle transaction id (txn_…) to open the checkout with.
  transactionId: z.string(),
});
export type IapCheckoutResponse = z.infer<typeof iapCheckoutResponseSchema>;

export const iapCheckoutEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/iap/checkout`,
  request: iapCheckoutRequestSchema,
  response: iapCheckoutResponseSchema,
});

// GET /v1/iap/prices → { prices: [{ plan, priceId }] } (authenticated)
// The catalog ids the storefront is CURRENTLY selling: one per plan on sale,
// the front of each PADDLE_PRICE_ID_* list (services/iap.ts, _the price → plan
// map_). bracemark-web's subscription section feeds them to
// `Paddle.PricePreview()` so the upgrade card can show the buyer's own currency
// and tax rather than the USD base price in iap/plans.ts — the Paddle-side
// counterpart of expo reading `displayPrice` off the store product.
//
// Served over the wire rather than inlined as a NEXT_PUBLIC_ var, even though a
// `pri_…` is public and the Paddle client token already is: "which price is on
// sale" is an invariant with exactly ONE owner — the front of the env list, read
// by createPaddleTransaction — and a second declaration in bracemark-web's
// `.env.*` could disagree with it without anything failing. The card would
// preview one price and the checkout would charge another, which is the precise
// drift the list-shaped env var was designed to make impossible.
//
// Display-only, and safe because of it: /iap/checkout still resolves the price
// server-side from the same list and accepts no price from the client, so this
// endpoint cannot influence what anyone is charged.
export const iapPricesResponseSchema = z.object({
  // A plan whose price id is unconfigured in this env is simply ABSENT rather
  // than null — the client's fallback (show the base price, keep the button
  // live) is then the same code path as "Paddle.js hasn't answered yet", and
  // the operator-facing complaint about the missing config stays where it can
  // act on it: the 500 createPaddleTransaction already throws.
  prices: z.array(
    z.object({
      plan: z.enum(AVAILABLE_PAID_PLANS),
      priceId: z.string(),
    }),
  ),
});
export type IapPricesResponse = z.infer<typeof iapPricesResponseSchema>;

export const iapPricesEndpoint = defineEndpoint({
  method: 'GET',
  path: `${API_V1}/iap/prices`,
  request: z.object({}),
  response: iapPricesResponseSchema,
});

// POST /v1/iap/verify → SubscriptionStatus (authenticated)
// The store-receipt seam, reserved NOW for bracemark-expo: App Store / Play Store
// purchases are client-side events the server only learns about from a receipt
// the app submits (unlike Paddle, where checkout carries our userId straight to
// the webhook). bracemark-api verifies the token against the store's API and
// records the purchase, bound to the session's account (first sight is for
// life). The response is the fresh fold, so there is no post-purchase polling
// on this path — unlike the web's webhook wait. See docs/iap.md.
export const iapVerifyRequestSchema = z.object({
  source: z.enum(['appstore', 'playstore']),
  // The store product identifier of the purchased subscription.
  productId: z.string().min(1),
  // The store's proof of purchase: a Play Billing purchase token, or the App
  // Store originalTransactionId to look up via the App Store Server API.
  token: z.string().min(1),
});
export type IapVerifyRequest = z.infer<typeof iapVerifyRequestSchema>;

export const iapVerifyEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/iap/verify`,
  request: iapVerifyRequestSchema,
  response: subscriptionStatusSchema,
});

// POST /v1/iap/portal → { url } (authenticated)
// Mints a short-lived Paddle customer-portal session URL — where a Paddle
// subscriber manages payment method, invoices, and cancellation. Server-minted
// because the portal API needs the secret Paddle API key and the stored Paddle
// customer id; the client just opens the returned URL. 404s when the account
// has no Paddle subscription (store subscriptions are managed in the store).
export const iapPortalResponseSchema = z.object({
  url: z.string(),
});
export type IapPortalResponse = z.infer<typeof iapPortalResponseSchema>;

export const iapPortalEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/iap/portal`,
  request: z.object({}),
  response: iapPortalResponseSchema,
});
