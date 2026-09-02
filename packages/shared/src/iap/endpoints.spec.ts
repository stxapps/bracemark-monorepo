import {
  iapCheckoutRequestSchema,
  iapPricesResponseSchema,
  subscriptionStatusSchema,
} from './endpoints';
import { AVAILABLE_PAID_PLANS, PAID_PLANS, PLANS } from './plans';

// Most of this contract is declarative and gets exercised where it runs — every route
// in bracemark-api's routes/iap.spec.ts parses through these schemas. What that spec
// never asks is which PLAN VOCABULARY each schema was given, and that is not a
// detail: the storefront gate lives in the wire contract itself (a checkout for a
// plan we don't sell is refused before any Paddle call), while the status contract
// deliberately speaks the FULL catalog so an unsold plan can still be granted. The
// two look like the same enum in a diff, and swapping either is silent.
//
// Everything below derives its cases from plans.ts, so putting Pro on sale stays the
// one-line change plans.ts promises — these tests move with it instead of failing.

// Widened so `includes` can be asked about a plan the storefront tuple doesn't name
// — the narrow literal type is exactly what makes that a compile error.
const onSale: readonly string[] = AVAILABLE_PAID_PLANS;
const notOnSale = PAID_PLANS.filter((plan) => !onSale.includes(plan));

describe('iapCheckoutRequestSchema', () => {
  it.each([...AVAILABLE_PAID_PLANS])('accepts %s — the plans actually on sale', (plan) => {
    expect(iapCheckoutRequestSchema.safeParse({ plan }).success).toBe(true);
  });

  it('refuses a paid plan that is not yet on sale', () => {
    // Pro is fully specified — entitlements, price, the server's Paddle price branch
    // — but must not be purchasable, and the wire contract is what enforces that.
    // Widen this enum to PAID_PLANS and the checkout reaches createPaddleTransaction
    // for a price id no env configures. Vacuous once everything is on sale, which is
    // the correct behaviour rather than a test to delete.
    for (const plan of notOnSale) {
      expect(iapCheckoutRequestSchema.safeParse({ plan }).success).toBe(false);
    }
  });

  it('refuses a checkout for the free plan', () => {
    expect(iapCheckoutRequestSchema.safeParse({ plan: 'free' }).success).toBe(false);
  });
});

describe('iapPricesResponseSchema', () => {
  it('reports prices only for the plans on sale', () => {
    // Display-only, but it feeds Paddle.PricePreview: a row for an unsold plan would
    // render an upgrade card whose button hits a checkout the contract above rejects.
    const onSale = AVAILABLE_PAID_PLANS.map((plan) => ({ plan, priceId: 'pri_x' }));
    expect(iapPricesResponseSchema.safeParse({ prices: onSale }).success).toBe(true);

    for (const plan of notOnSale) {
      expect(
        iapPricesResponseSchema.safeParse({ prices: [{ plan, priceId: 'pri_x' }] }).success,
      ).toBe(false);
    }
  });

  it('accepts an empty list — an unconfigured plan is ABSENT, not null', () => {
    // The client's fallback (base price, button still live) is the same code path as
    // "Paddle.js hasn't answered yet", so the schema must not require a row per plan.
    expect(iapPricesResponseSchema.safeParse({ prices: [] }).success).toBe(true);
    expect(
      iapPricesResponseSchema.safeParse({ prices: [{ plan: 'plus', priceId: null }] }).success,
    ).toBe(false);
  });
});

describe('subscriptionStatusSchema', () => {
  const status = (overrides: Record<string, unknown> = {}) => ({
    plan: 'plus',
    status: 'active',
    source: 'paddle',
    expiresAt: 1_700_000_000_000,
    willRenew: true,
    ...overrides,
  });

  it('speaks the FULL plan catalog, not the storefront', () => {
    // The deliberate asymmetry with checkout above: a manual grant (comps, lifetime
    // deals) and the high-water quota fold can both report a plan that is off the
    // storefront. Narrow this enum to AVAILABLE_PAID_PLANS "for consistency" and
    // every one of those accounts fails to parse its own subscription on every
    // device — a paying customer locked out of what they were granted.
    for (const plan of PLANS) {
      expect(subscriptionStatusSchema.safeParse(status({ plan })).success).toBe(true);
    }
  });

  it.each(['none', 'active', 'trialing', 'grace'])('carries the %s state', (value) => {
    expect(subscriptionStatusSchema.safeParse(status({ status: value })).success).toBe(true);
  });

  it('refuses a provider’s own vocabulary', () => {
    // 'past_due' is Paddle's word; ours is 'grace'. The fold must translate before the
    // wire, or the settings UI branches on a state it has no copy for.
    expect(subscriptionStatusSchema.safeParse(status({ status: 'past_due' })).success).toBe(false);
    expect(subscriptionStatusSchema.safeParse(status({ status: 'canceled' })).success).toBe(false);
  });

  it('requires the nullable fields to be PRESENT, null and absent being different answers', () => {
    // `source: null` / `expiresAt: null` are real answers — no provider, no expiry (a
    // lifetime or manual grant). `undefined` is a server that forgot to say, and the
    // UI cannot tell the two apart: "expires on <null>" renders as a missing date,
    // "expires on <undefined>" renders as Invalid Date.
    expect(
      subscriptionStatusSchema.safeParse(status({ source: null, expiresAt: null })).success,
    ).toBe(true);

    for (const field of ['source', 'expiresAt', 'willRenew']) {
      const partial = status();
      delete (partial as Record<string, unknown>)[field];
      expect(subscriptionStatusSchema.safeParse(partial).success).toBe(false);
    }
  });

  it('keeps expiresAt an integer epoch, not a date string', () => {
    // Both clients cache this and hand it straight to a Date — an ISO string from a
    // drifted server would format fine in one place and NaN in another.
    expect(subscriptionStatusSchema.safeParse(status({ expiresAt: '2026-01-01' })).success).toBe(
      false,
    );
    expect(subscriptionStatusSchema.safeParse(status({ expiresAt: 1.5 })).success).toBe(false);
  });
});
