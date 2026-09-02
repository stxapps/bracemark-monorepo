import { entitlementsOf, PLANS } from '@stxapps/shared';

import { PAYWALL_COPY, type PaywallFeature } from './paywall-copy';

// The one thing in this file that is a CLAIM rather than a string: each gate names
// the plan its CTA sells, and `paywall-copy.ts`'s header asks that "the plan named
// here must actually grant the feature". Nothing pins that. The `Record` type pins
// the key set and `AvailablePaidPlan` pins that the plan is on sale, but neither
// knows what a plan unlocks — the entitlement table lives in a different package
// (@stxapps/shared iap/plans.ts), so a gate can promise a plan that doesn't grant
// it, or gate something that was free all along, and typecheck.
//
// The failure is a sale: the user reads the dialog, pays, comes back, and the
// feature is still locked. It is also the one direction no e2e run reaches, since
// the fixtures buy the plan the dialog names.
//
// Derived from PAYWALL_COPY rather than listing the three gates, so a fourth one
// moves this spec with it.
const FEATURES = Object.keys(PAYWALL_COPY) as PaywallFeature[];

describe('PAYWALL_COPY — every gate sells a plan that grants it', () => {
  it.each(FEATURES)('%s is granted by the plan its CTA names', (feature) => {
    expect(entitlementsOf(PAYWALL_COPY[feature].plan)[feature]).toBe(true);
  });

  // The inverse, and the one that makes a gate a lie in the other direction: a
  // dialog in front of something free takes payment for nothing.
  it.each(FEATURES)('%s is actually withheld from free', (feature) => {
    expect(entitlementsOf('free')[feature]).toBe(false);
  });

  // The CHEAPEST plan that grants it, not merely A plan that does. With one plan on
  // sale this is the same assertion; it stops being so the moment Pro ships, when a
  // Plus feature could be sold at the Pro price by naming the wrong plan — which
  // typechecks, and which the two rungs above would both pass.
  it.each(FEATURES)('%s names the cheapest plan that grants it', (feature) => {
    const cheapest = PLANS.find((plan) => entitlementsOf(plan)[feature]);
    expect(PAYWALL_COPY[feature].plan).toBe(cheapest);
  });
});
