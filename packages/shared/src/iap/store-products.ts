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
