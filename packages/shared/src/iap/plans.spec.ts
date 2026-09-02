import {
  AVAILABLE_CADENCES,
  AVAILABLE_PAID_PLANS,
  BILLING_CADENCES,
  type Entitlements,
  entitlementsOf,
  LIFETIME_PLAN,
  LIFETIME_USD,
  PAID_PLANS,
  PLAN_CARD_COPY,
  PLAN_CARDS,
  PLAN_USD_PER_MONTH,
  PLAN_USD_PER_YEAR,
  PLANS,
  TRIAL_CADENCES,
  TRIAL_DAYS,
} from './plans';

// plans.ts is hand-maintained DATA read by both edges — the client paywall derives
// gates and copy from it, bracemark-api's quota gate enforces the same numbers — and
// data is where a typo hides best: every value here typechecks whatever it says, and
// no runtime anywhere asks whether the table as a whole still makes sense.
//
// So this file tests the RELATIONS, never the values. Asserting `maxLinks === 200`
// would only restate the table (and fail every time it is tuned, which is what the
// header invites); asserting that a higher plan never takes something away catches
// the edit that would ship a downgrade as an upgrade. The one exception is where a
// specific value carries meaning the type doesn't — `null` for unlimited.
//
// The server-side folds over this table have their own specs in bracemark-api
// (services/iap.spec.ts `foldQuotaCeilings`, lib/quota.spec.ts); the table's own
// shape had none.

describe('the plan sets', () => {
  it('keeps the paid catalog as PLANS minus free, in the same order', () => {
    // Order is load-bearing twice over: the monotonicity walk below reads PLANS as a
    // ladder, and /pricing renders `['free', ...AVAILABLE_PAID_PLANS]` as columns.
    expect([...PAID_PLANS]).toEqual(PLANS.filter((plan) => plan !== 'free'));
  });

  it('keeps the storefront a subset of the catalog, in catalog order', () => {
    // The split the whole file is built around: putting Pro on sale is one line here
    // and nothing else moves. A storefront naming a plan the catalog doesn't have
    // would price and sell something `entitlementsOf` cannot answer for.
    const onSale: readonly string[] = AVAILABLE_PAID_PLANS;
    expect([...AVAILABLE_PAID_PLANS]).toEqual(PAID_PLANS.filter((plan) => onSale.includes(plan)));
  });
});

// The keys are derived from the table rather than listed, so a gate or ceiling added
// later is checked by these tests without anyone remembering to come back here.
const FREE = entitlementsOf('free');
type BooleanGate = {
  [K in keyof Entitlements]: Entitlements[K] extends boolean ? K : never;
}[keyof Entitlements];
type Ceiling = {
  [K in keyof Entitlements]: Entitlements[K] extends number | null ? K : never;
}[keyof Entitlements];

const KEYS = Object.keys(FREE) as (keyof Entitlements)[];
const BOOLEAN_GATES = KEYS.filter((key) => typeof FREE[key] === 'boolean') as BooleanGate[];
const CEILINGS = KEYS.filter(
  (key) => typeof FREE[key] === 'number' || FREE[key] === null,
) as Ceiling[];

// `null` is unlimited, so it sits ABOVE every number rather than below it.
const notLower = (higher: number | null, lower: number | null): boolean =>
  higher === null || (lower !== null && higher >= lower);

describe('entitlementsOf', () => {
  // Walk the ladder one rung at a time: free → plus, plus → pro.
  it.each(PLANS.slice(1).map((plan, index) => [PLANS[index], plan] as const))(
    '%s → %s never takes anything away',
    (lowerPlan, higherPlan) => {
      // A higher plan that quietly lowers a ceiling or drops a gate is a downgrade
      // sold as an upgrade — and the reader who notices is a paying customer whose
      // feature disappeared. Nothing else in the workspace compares two plans.
      const lower = entitlementsOf(lowerPlan);
      const higher = entitlementsOf(higherPlan);

      expect(CEILINGS.filter((key) => !notLower(higher[key], lower[key]))).toEqual([]);
      expect(BOOLEAN_GATES.filter((key) => lower[key] && !higher[key])).toEqual([]);
      expect(['none', 'basic', 'full'].indexOf(higher.aiTier)).toBeGreaterThanOrEqual(
        ['none', 'basic', 'full'].indexOf(lower.aiTier),
      );
    },
  );

  it('spells "unlimited" as null on the paid plans, and caps only free', () => {
    // The one place a specific VALUE matters: both edges read `null` as unlimited, so
    // a paid plan given a very large number instead would render "999,998 of
    // 1,000,000 links" and refuse a save at a cap nobody meant to sell.
    expect(FREE.maxLinks).toEqual(expect.any(Number));
    for (const plan of PAID_PLANS) expect(entitlementsOf(plan).maxLinks).toBeNull();
  });

  it('covers every plan the wire can report, not just the ones on sale', () => {
    // A manual/high-water grant of a plan that is off the storefront still reaches
    // `entitlementsOf` (iap/status carries the full PLANS enum), so an unsold plan
    // must still answer with a table rather than undefined.
    for (const plan of PLANS) expect(entitlementsOf(plan)).toBeDefined();
  });
});

describe('prices', () => {
  it('makes a year cheaper than twelve months, on every paid plan', () => {
    // The annual plan's entire reason to exist, and the file argues the exact
    // tradeoff: monthly at a price that erases the discount makes annual pointless
    // while paying twelve processor charges instead of one.
    for (const plan of PAID_PLANS) {
      expect(PLAN_USD_PER_YEAR[plan]).toBeLessThan(12 * PLAN_USD_PER_MONTH[plan]);
    }
  });

  it('charges more for the plan that unlocks more', () => {
    // PAID_PLANS is lowest-first, so each rung must cost strictly more than the one
    // below — otherwise the upgrade card asks for money and offers a discount.
    for (const [index, plan] of PAID_PLANS.slice(1).entries()) {
      const below = PAID_PLANS[index];
      expect(PLAN_USD_PER_YEAR[plan]).toBeGreaterThan(PLAN_USD_PER_YEAR[below]);
      expect(PLAN_USD_PER_MONTH[plan]).toBeGreaterThan(PLAN_USD_PER_MONTH[below]);
    }
  });

  it('attaches lifetime to a paid plan, priced above a year of it', () => {
    // How many years' payback is a judgement call; that a one-time price must beat a
    // single year of the same plan is not — below that, every renewing subscriber is
    // better off cancelling and buying lifetime.
    expect(PAID_PLANS).toContain(LIFETIME_PLAN);
    expect(LIFETIME_USD).toBeGreaterThan(PLAN_USD_PER_YEAR[LIFETIME_PLAN]);
  });
});

describe('cadences and the trial', () => {
  it('keeps the cadences on sale a subset of the ones that exist', () => {
    expect(BILLING_CADENCES).toEqual(expect.arrayContaining([...AVAILABLE_CADENCES]));
  });

  it('runs the trial only on a cadence a buyer can actually reach', () => {
    // The trial period is configured on the yearly `pri_…` in the Paddle catalog, so
    // a TRIAL_CADENCES entry that is not on sale is copy promising a checkout that
    // does not exist.
    expect(AVAILABLE_CADENCES).toEqual(expect.arrayContaining([...TRIAL_CADENCES]));
  });

  it('gives the trial at least a full weekly usage cycle', () => {
    // The stated rule, not the number: Bracemark's value is cumulative, so a trial
    // shorter than a week expires before the habit that justifies paying forms.
    expect(TRIAL_DAYS).toBeGreaterThanOrEqual(7);
  });
});

describe('PLAN_CARDS', () => {
  it('renders one card per plan on sale, in storefront order, with that plan’s copy', () => {
    // Three surfaces map straight over this list (both settings sections and
    // /pricing), so an unsold plan reaching it becomes a buy button for a checkout
    // the contract rejects.
    expect(PLAN_CARDS.map((card) => card.plan)).toEqual([...AVAILABLE_PAID_PLANS]);
    for (const card of PLAN_CARDS) {
      expect(card.blurb).toBe(PLAN_CARD_COPY[card.plan].blurb);
      expect(card.features).toEqual(PLAN_CARD_COPY[card.plan].features);
    }
  });

  it('gives every card something to render', () => {
    // An empty features array is a card that prices a plan and lists nothing it
    // unlocks — it renders, so nothing else complains.
    for (const card of PLAN_CARDS) {
      expect(card.blurb.trim().length).toBeGreaterThan(0);
      expect(card.features.length).toBeGreaterThan(0);
      expect(card.features.every((feature) => feature.trim().length > 0)).toBe(true);
    }
  });
});
