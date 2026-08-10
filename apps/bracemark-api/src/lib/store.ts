import type { SubscriptionSource } from '@stxapps/shared';

import type { PurchaseStatus } from '../db/repositories/purchases';

// The provider-agnostic store vocabulary — what lib/appstore.ts and
// lib/playstore.ts each normalize their store's response INTO, and the only
// store shape services/iap.ts ever sees. Neither provider edge imports the
// other; both import this.

// The sources backed by a store API we can call back to (docs/iap.md — the
// store purchase flow). Narrowed from the shared vocabulary rather than
// respelled, so renaming a source there fails here instead of drifting:
// 'paddle' has its own webhook path, and 'manual' is a server-side grant with
// nothing to verify against.
export type StoreSource = Extract<SubscriptionSource, 'appstore' | 'playstore'>;

// One normalized snapshot of the subscription a looked-up token belongs to.
// `plan` mapping stays in the service (the shared planOfStoreProduct table).
export type StoreSubscriptionSnapshot = {
  externalId: string; // the provider's stable subscription identity
  productId: string;
  status: PurchaseStatus;
  expiresAt: number | null;
  canceledAt: number | null;
  // Play only — the purchase token this one replaced, which the service must
  // then retire. Apple has no analogue: originalTransactionId is stable across
  // an upgrade/downgrade within a subscription group, so a plan change UPDATES
  // the existing row rather than minting a second identity that can go on
  // entitling in parallel.
  linkedExternalId?: string | null;
  // Play only — true while Google still reports the purchase unacknowledged
  // (`acknowledgementState`), i.e. the 3-day auto-refund fuse is burning. Every
  // path that records the entitlement re-checks it and acknowledges, so the
  // acknowledge converges instead of being fire-once. Apple has no acknowledge
  // concept at all.
  needsAcknowledge?: boolean;
};
