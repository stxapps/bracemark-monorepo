// The device-local last-known subscription copy — the expo sibling of
// web-react's data/subscription-store.ts, same API and trust model (a soft
// per-device cache over `GET /v1/iap/status`; everything that costs money is
// re-checked server-side at `files/sign` regardless, so staleness fails soft in
// both directions).
//
// Web keeps this in localStorage ONLY because the value is wanted SYNCHRONOUSLY
// at first render — to seed react-query's placeholderData so a cold/offline
// start keeps the account's plan instead of flashing free — and IndexedDB can't
// read synchronously. expo-sqlite can (drizzle's expo driver is a sync driver),
// so here the cache lives with its sibling stores in bracemark-data.db (see the
// table note in db.ts) and these functions stay synchronous like web's.

import { eq } from 'drizzle-orm';

import { type SubscriptionStatus, subscriptionStatusSchema } from '@stxapps/shared';

import { getDb, subscriptionStatus } from './db';

// The constant primary key — one cached status per device (db.ts).
const SUBSCRIPTION_STATUS_ID = 'singleton' as const;

// The device's last-known status, or null if none is cached / storage errors.
// Parsed through the wire schema so a stale/corrupt shape degrades to null,
// never a crash or a malformed plan string reaching entitlementsOf.
export function readCachedStatus(): SubscriptionStatus | null {
  try {
    const row = getDb()
      .select()
      .from(subscriptionStatus)
      .where(eq(subscriptionStatus.id, SUBSCRIPTION_STATUS_ID))
      .get();
    if (!row) return null;
    const parsed = subscriptionStatusSchema.safeParse(row.value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Persist a fresh answer as the device's last-known copy. A no-op on storage
// failure — the in-memory query cache still serves this session.
export function writeCachedStatus(status: SubscriptionStatus): void {
  try {
    getDb()
      .insert(subscriptionStatus)
      .values({ id: SUBSCRIPTION_STATUS_ID, value: status })
      .onConflictDoUpdate({ target: subscriptionStatus.id, set: { value: status } })
      .run();
  } catch {
    // Storage unavailable — skip persistence.
  }
}

// Drop the cached copy — called from the sign-out path (clear-data.ts) so the
// next account on this device doesn't inherit the previous account's plan.
export function clearCachedSubscriptionStatus(): void {
  try {
    getDb()
      .delete(subscriptionStatus)
      .where(eq(subscriptionStatus.id, SUBSCRIPTION_STATUS_ID))
      .run();
  } catch {
    // Storage unavailable — nothing cached to clear.
  }
}
