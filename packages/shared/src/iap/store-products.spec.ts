import { PAID_PLANS } from './plans';
import { planOfStoreProduct, STORE_PRODUCT_IDS } from './store-products';

// The one table read from both ends of a store purchase: bracemark-expo buys these
// SKUs, and bracemark-api maps a VERIFIED purchase's productId back to the plan it
// entitles. The api route spec covers what happens when the map answers null (422)
// and when it answers a plan (the recorded entitlement); what it can't cover is the
// map being wrong in a way that still answers — which is this file.

describe('planOfStoreProduct', () => {
  it.each([...PAID_PLANS])('round-trips the %s product id', (plan) => {
    expect(planOfStoreProduct(STORE_PRODUCT_IDS[plan])).toBe(plan);
  });

  it.each([
    ['an id we never sold', 'bracemark.team.yearly'],
    ['another app’s id', 'com.example.other.plus'],
    ['an empty id', ''],
  ])('returns null for %s', (_name, productId) => {
    // The caller logs and rejects on null (bracemark-api 422s the verify). Returning
    // a plan here instead would entitle an account off a purchase of something else.
    expect(planOfStoreProduct(productId)).toBeNull();
  });

  it.each([
    ['a different case', 'BRACEMARK.PLUS.YEARLY'],
    ['surrounding space', ' bracemark.plus.yearly '],
    ['a prefix', 'x.bracemark.plus.yearly'],
    ['a suffix', 'bracemark.plus.yearly.v2'],
  ])('does not match on %s — the store’s id is compared verbatim', (_name, productId) => {
    // A store hands back exactly the identifier registered in its console, so any
    // normalizing here (trim, lowercase, prefix-strip) would only ever widen the map
    // to ids we did not sell.
    expect(planOfStoreProduct(productId)).toBeNull();
  });
});

describe('STORE_PRODUCT_IDS', () => {
  it('carries an id for the FULL paid catalog, including a plan not yet on sale', () => {
    // Keyed by PaidPlan on purpose: Pro's id is spec-in-waiting so that putting Pro
    // on sale stays the one-line AVAILABLE_PAID_PLANS change.
    expect(Object.keys(STORE_PRODUCT_IDS).sort()).toEqual([...PAID_PLANS].sort());
  });

  it('gives each plan a DISTINCT id', () => {
    // planOfStoreProduct returns the first key that matches, so two plans sharing an
    // id silently entitles whichever one Object.entries reaches first — a Pro
    // purchase recorded as Plus, with the purchase itself perfectly valid.
    const ids = Object.values(STORE_PRODUCT_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('spells every id the way BOTH stores accept', () => {
    // One id string serves App Store Connect and Play Console, and Play rejects
    // uppercase and most punctuation. A rejected id is only discovered in a console,
    // long after the constant lands — nothing here or in either app would fail first.
    for (const id of Object.values(STORE_PRODUCT_IDS)) {
      expect(id).toMatch(/^[a-z0-9]+(?:\.[a-z0-9]+)*$/);
    }
  });
});
