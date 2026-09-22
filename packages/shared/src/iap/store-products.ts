import type { PaidPlan, Plan } from './plans';

// The store product catalog — the App Store / Play Store product ids for each
// paid plan, defined once and read by BOTH edges (the plans.ts move): bracemark-expo
// fetches and purchases these SKUs (`fetchProducts({ skus })`), and bracemark-api's
// store verifiers map a verified purchase's productId back to the plan it
// entitles (the authoritative mapping — never the client's word, same rule as
// the Paddle price-id branch in services/iap.ts).
//
// Unlike Paddle's `pri_…` ids (minted per env — sandbox and live differ, so they
// live in wrangler vars), store product ids are CHOSEN BY US and identical in
// sandbox and production — App Store sandbox and Play test tracks exercise the
// real catalog — so they are shared constants, not env config. One id string is
// used on both stores on purpose (both allow lowercase + dots), so the
// client-side SKU list and the server-side reverse map stay one table.
//
// The catalog is keyed by the FULL paid catalog (PaidPlan), not just
// AVAILABLE_PAID_PLANS: Pro's id is spec-in-waiting exactly like its Paddle
// price env var — putting Pro on sale stays the one-line AVAILABLE_PAID_PLANS
// change, with the store products created in App Store Connect / Play Console.
export const STORE_PRODUCT_IDS: Record<PaidPlan, string> = {
  plus: 'bracemark.plus.yearly',
  pro: 'bracemark.pro.yearly',
};

// productId → plan, for the server verifiers (and any client that needs to
// recognize a store purchase). Null for an id we never sold — the caller logs
// and rejects, mirroring the unknown-Paddle-price branch.
export function planOfStoreProduct(productId: string): Exclude<Plan, 'free'> | null {
  for (const [plan, id] of Object.entries(STORE_PRODUCT_IDS) as [PaidPlan, string][]) {
    if (id === productId) return plan;
  }
  return null;
}

// The Play Console OFFER TAG that marks our free-trial offer.
//
// Play has no trial STATUS: a subscription inside its trial phase reads
// SUBSCRIPTION_STATE_ACTIVE like any other, and v1's `paymentState: 2` ("free
// trial") did not survive into subscriptionsv2. The offer applied to the line
// item is the only signal — and `offerId` alone won't do, since a paid
// introductory offer carries one too (Apple's PAY_AS_YOU_GO/PAY_UP_FRONT
// problem, same shape). A TAG rather than an id also means regional or
// campaign-specific trial offers all share one marker, so adding an offer in
// Play Console never needs a deploy.
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
//
// Read by BOTH edges, like STORE_PRODUCT_IDS: bracemark-api's `lib/playstore.ts`
// folds a tagged line item to `trialing`, and bracemark-expo's `lib/iap.ts`
// buys the tagged offer when Play lists it (Play lists only the offers the
// buyer is eligible for, so a returning subscriber falls back to the base plan).
export const PLAY_FREE_TRIAL_OFFER_TAG = 'free-trial';
