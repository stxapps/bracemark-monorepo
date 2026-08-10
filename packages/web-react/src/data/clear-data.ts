'use client';

// The sign-out teardown: wipe EVERY device-local per-account store in one place.
// This is the one operation that deliberately reaches across all the stores —
// Dexie tables plus the non-Dexie caches — so it lives on its own rather than in
// any single store (each of those stays single-responsibility). The local store
// holds DECRYPTED bookmarks, so a second user on the same device must not read the
// first's plaintext; `localSettings`, `locks`, and the cached subscription copy are
// wiped for the same "next account here must not inherit this one's state" reason.
// Deliberately not account-scoped: `items` carries no owner column (see
// PendingOpRecord in db.ts), so a scoped clear would leave the previous account's
// plaintext behind.
//
// Called from auth-provider's endSession (and so the onSessionInvalid path)
// alongside clearSession — so this is the ONE teardown choke point every sign-out
// path (deliberate, expired-token, and the signed-out resolution guard) funnels
// through; anything that must not outlive an account on this device belongs here.
// (delete-all-data.ts wipes a SUBSET while staying signed in — synced stores yes,
// identity/device stores no; keep the two aligned when adding a store here.)

import { clearDecodeCache } from '@stxapps/shared';

import { db } from './db';
import { clearSidebarCollapsedIds } from './sidebar-view-store';
import { clearCachedSubscriptionStatus } from './subscription-store';

export async function clearData(): Promise<void> {
  await Promise.all([
    db.items.clear(),
    db.syncMeta.clear(),
    db.pendingOps.clear(),
    db.localSettings.clear(),
    // Locks are device-local passwords for this account's session; wiping them
    // here IS the "forgot a lock password → sign out" recovery path (db.ts).
    db.locks.clear(),
    // Each icon is public, but the SET of hosts is this account's browsing shape —
    // so the cache goes with the plaintext it describes (db.ts, FaviconRecord).
    db.favicons.clear(),
  ]);
  clearDecodeCache(); // drop decoded-link plaintext too — mirrors this items wipe (decode-cache.ts)
  // Drop the device's last-known subscription copy for the same "next account
  // must not inherit this one's state" reason as localSettings (subscription-store.ts).
  clearCachedSubscriptionStatus();
  // The links-drawer collapse state — its ids are this account's list/tag ids,
  // so the next account must not inherit them (sidebar-view-store.ts). A device
  // store like localSettings, so it's wiped here on sign-out but NOT by
  // delete-all-data (which keeps device/identity stores).
  clearSidebarCollapsedIds();
}
