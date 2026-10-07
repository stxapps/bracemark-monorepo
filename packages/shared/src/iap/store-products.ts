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

// The Play Console OFFER TAG that marks our free-trial offer — how
// bracemark-expo's `lib/iap.ts` finds the offer to BUY. Play lists the base
// plan and every offer the buyer is eligible for in no promised order, so
// buying the first entry would grant or skip the trial by list order (and a
// returning subscriber, who is listed no trial offer, falls back to the base
// plan). A TAG rather than an offer id, since a paid introductory offer
// carries an id too, and so regional or campaign-specific trial offers all
// share one marker: adding an offer in Play Console never needs a deploy.
//
// TAG THE OFFER, NEVER THE BASE PLAN. `offerTags` includes tags INHERITED from
// the base plan, so a base-plan tag would sit on the base plan's own entry as
// well and the lookup could no longer tell the trial offer from it — back to
// list order.
//
// NOT how the server recognizes a trial, though it used to be, and the reason
// is worth keeping: the tag marks the offer a purchase was MADE under, not the
// phase it is in. Play carries ONE line item across the trial→paid boundary
// and leaves `offerDetails` on it for good, so a subscriber who has been
// charged still reads `offerTags: ['free-trial']`. bracemark-api's
// `lib/playstore.ts` keys on the line's `offerPhase` instead (docs/iap.md, the
// trial).
export const PLAY_FREE_TRIAL_OFFER_TAG = 'free-trial';
