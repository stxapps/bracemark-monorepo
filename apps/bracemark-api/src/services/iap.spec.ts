import { describe, expect, it } from 'vitest';

import { entitlementsOf } from '@stxapps/shared';

import type { PurchaseEntity } from '../db/repositories/purchases';
import { foldQuotaCeilings, foldSubscriptionStatus } from './iap';

// The two folds over the same purchase rows, and the property that separates
// them: `foldSubscriptionStatus` answers "what may this account do today" and
// expires; `foldQuotaCeilings` answers "what did we already agree to store for
// it" and does not. The webhook/provider machinery around them is covered
// end-to-end in routes/iap.spec.ts — these are the pure cases, which is where
// the divergence is worth pinning.

const DAY_MS = 24 * 60 * 60 * 1000;
const now = 1_700_000_000_000;

const free = entitlementsOf('free');
const plus = entitlementsOf('plus');
const pro = entitlementsOf('pro');

let seq = 0;
function purchase(overrides: Partial<PurchaseEntity> = {}): PurchaseEntity {
  seq += 1;
  return {
    id: `purchase-${seq}`,
    userId: 'user-1',
    source: 'paddle',
    externalId: `sub_${seq}`,
    plan: 'plus',
    status: 'active',
    providerCustomerId: null,
    expiresAt: now + 30 * DAY_MS,
    canceledAt: null,
    linkedExternalId: null,
    lastSyncedAt: now,
    ...overrides,
  };
}

describe('foldQuotaCeilings', () => {
  it('gives an account with no purchase history the free ceilings', () => {
    expect(foldQuotaCeilings([])).toEqual({
      maxFiles: free.maxFiles,
      maxBytes: free.maxBytes,
    });
  });

  it('follows the current plan while it is live', () => {
    expect(foldQuotaCeilings([purchase({ plan: 'plus' })])).toEqual({
      maxFiles: plus.maxFiles,
      maxBytes: plus.maxBytes,
    });
  });

  it('keeps the paid ceilings after the subscription lapses', () => {
    // The whole point: this row entitles nothing any more, and the status fold
    // says so — but the blobs it uploaded are still ours to store, so the gate
    // must not turn them read-only.
    const lapsed = [
      purchase({
        plan: 'plus',
        status: 'canceled',
        expiresAt: now - DAY_MS,
        canceledAt: now - DAY_MS,
      }),
    ];
    expect(foldSubscriptionStatus(lapsed, now).plan).toBe('free');
    expect(foldQuotaCeilings(lapsed)).toEqual({
      maxFiles: plus.maxFiles,
      maxBytes: plus.maxBytes,
    });
  });

  it('keeps them after a trial expires unconverted — the day-15 case', () => {
    // A 14-day trial that imported a big library and did not convert. Under the
    // current-plan rule this account woke up unable to retitle or even trash a
    // link (docs/iap.md, _enforcement_).
    const trial = [purchase({ plan: 'plus', status: 'trialing', expiresAt: now - 2 * DAY_MS })];
    expect(foldSubscriptionStatus(trial, now).plan).toBe('free');
    expect(foldQuotaCeilings(trial)).toEqual({
      maxFiles: plus.maxFiles,
      maxBytes: plus.maxBytes,
    });
  });

  it('takes the HIGH-WATER plan across rows, entitled or not', () => {
    // A lapsed Pro alongside a live Plus: the ceiling is Pro's, because Pro is
    // what the account stored under. The status fold still says Plus.
    const rows = [
      purchase({ plan: 'plus', status: 'active' }),
      purchase({ plan: 'pro', status: 'canceled', expiresAt: now - 90 * DAY_MS }),
    ];
    expect(foldSubscriptionStatus(rows, now).plan).toBe('plus');
    expect(foldQuotaCeilings(rows)).toEqual({
      maxFiles: pro.maxFiles,
      maxBytes: pro.maxBytes,
    });
  });

  it('is monotonic — no status, expiry or clock can lower a ceiling', () => {
    // Every terminal/negative state a row can be in, at once. The ceiling is
    // read from the row's PLAN alone, so none of them subtract; that is what
    // makes an out-of-order webhook or a dunning window unable to strand a
    // library that fit a moment ago.
    for (const status of ['active', 'trialing', 'past_due', 'paused', 'canceled'] as const) {
      const rows = [purchase({ plan: 'plus', status, expiresAt: now - 365 * DAY_MS })];
      expect(foldQuotaCeilings(rows).maxBytes).toBe(plus.maxBytes);
    }
  });
});
