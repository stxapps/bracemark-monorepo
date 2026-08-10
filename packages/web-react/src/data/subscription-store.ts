'use client';

// The device-local last-known subscription copy — a tiny per-device cache over
// `GET /v1/iap/status`, owned here so the hooks layer (use-entitlements) stays
// reactivity-only. Read/write/clear the persisted shape; no network, no React.
//
// Why localStorage, not Dexie/IDB like its sibling stores: the value is wanted
// SYNCHRONOUSLY at first render, to seed react-query's placeholderData so an
// offline or cold start keeps the account's plan instead of flashing free and
// re-locking features until the network answers (localStorage is sync; IDB
// isn't). It's per-device cache — not user data, not synced.
//
// Trust model: this cache only gates CLIENT-side feature UX; everything that
// costs money is re-checked server-side at `files/sign` regardless (see
// bracemark-api lib/quota.ts). A stale cached plan therefore fails soft in both
// directions — an expired subscription keeps client features offline for a
// while (they cost ~nothing), and a fresh upgrade unlocks as soon as the status
// query lands.

import { type SubscriptionStatus, subscriptionStatusSchema } from '@stxapps/shared';

const STORAGE_KEY = 'bracemark.subscriptionStatus';

// The device's last-known status, or null if none is cached / storage is
// unavailable. Parsed through the wire schema so a stale/corrupt shape degrades
// to null, never a crash or a malformed plan string reaching entitlementsOf.
export function readCachedStatus(): SubscriptionStatus | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = subscriptionStatusSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Persist a fresh answer as the device's last-known copy. A no-op when storage
// is unavailable (private mode, quota) — the in-memory query cache still serves
// this session.
export function writeCachedStatus(status: SubscriptionStatus): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(status));
  } catch {
    // Storage unavailable — skip persistence.
  }
}

// Drop the cached copy — called from the sign-out path so the next account on
// this device doesn't inherit the previous account's plan.
export function clearCachedSubscriptionStatus(): void {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable — nothing cached to clear.
  }
}
