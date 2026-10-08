'use client';

// The favicon cache's read/write helpers — the per-HOST icon store (see
// FaviconRecord in db.ts for why this is device-local rather than an extraction
// facet). Single-responsibility like the other stores; the fetch that FILLS it
// lives in favicon-provider.tsx, and the read half the UI observes is
// use-favicon-url.ts.

import { db, type FaviconRecord } from './db';
import { assertAccountStillOwnsStore } from './sync-store';

// How long a `none` row (no reachable favicon) stands before another attempt is
// allowed. Long, because the answer rarely changes and the cost of being wrong is
// only a missing icon behind a monogram — but not forever, so a site that adds a
// favicon is eventually picked up. `ok` rows never expire: a site that CHANGES its
// icon is a cosmetic staleness no user would trade a re-fetch-per-host for, and
// signing out clears the table anyway.
export const FAVICON_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

// One host's cached row, or undefined if this host was never resolved. An exact
// primary-key get — no scan.
export async function readFavicon(host: string): Promise<FaviconRecord | undefined> {
  return db.favicons.get(host);
}

// Is there nothing usable for this host right now? True when the host is unknown,
// or when its `none` verdict has aged past FAVICON_RETRY_MS. The provider's fetch
// gate and the hook's request trigger share this so they can't disagree about what
// counts as a miss.
export function isFaviconStale(record: FaviconRecord | undefined, now = Date.now()): boolean {
  if (!record) return true;
  if (record.status === 'ok') return false;
  return now - record.fetchedAt >= FAVICON_RETRY_MS;
}

// BOTH WRITES ARE FENCED ON THE ACCOUNT (sync-store.ts, AccountFencedError),
// though the table has no owner column and an icon is public. What a row says is
// that somebody on this device saved a link to that host, and the provider writes
// after a network round trip — long enough for a sign-out to have wiped the store
// underneath it. A browser tab is saved by leaving: sign-out navigates off this
// origin and the document dies with the fetch. The INSTALLED app stays (AuthGuard
// goes to /sign-in in place), and there a fetch that was in flight wrote the
// signed-out account's host back into the empty table, after clearData had been
// and would not come again. The check shares the write's transaction, which
// includes the ownership row, so IndexedDB orders it against the teardown's clear:
// the write lands first and is cleared, or the clear lands first and this throws.
export async function putFavicon(username: string, host: string, bytes: Uint8Array): Promise<void> {
  await db.transaction('rw', db.syncMeta, db.favicons, async () => {
    await assertAccountStillOwnsStore(username);
    await db.favicons.put({ host, status: 'ok', bytes, fetchedAt: Date.now() });
  });
}

// Record "this host has no reachable favicon" so a reload doesn't re-buy the fetch.
// Fenced like putFavicon.
export async function putFaviconNone(username: string, host: string): Promise<void> {
  await db.transaction('rw', db.syncMeta, db.favicons, async () => {
    await assertAccountStillOwnsStore(username);
    await db.favicons.put({ host, status: 'none', fetchedAt: Date.now() });
  });
}
