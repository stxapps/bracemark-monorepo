// The sign-out teardown — the expo sibling of web-react's data/clear-data.ts:
// wipe EVERY device-local per-account store in one place (see there for the
// full rationale — decrypted data must not outlive the session, and the next
// account on this device must not inherit this one's state; deliberately not
// account-scoped since `items` carries no owner column). The one operation that
// reaches across all the stores, so it lives on its own; anything that must not
// outlive an account on this device belongs here. (delete-all-data.ts wipes a
// SUBSET while staying signed in — synced stores yes, identity/device stores
// no; keep the two aligned when adding a store here.)
//
// The expo split adds one member web doesn't have: the on-disk plaintext
// `files/` blobs (file-store.ts) — the file-system half of the `items` wipe.
// The tables clear in ONE transaction; the directory delete can't join it
// (different medium), but the ordering fails safe: tables first, so a crash
// in between leaves orphan files with no rows pointing at them, invisible to
// the app and removed by the next clearData or materialize-overwrite.
//
// And two things an EMPTY TABLE does not mean on this platform, both invisible
// to anything that reads the store through the store: the deleted rows are
// still in the sqlite file (scrubFreedPages), and the cache dir holds whatever
// plaintext was parked there for another app or module to read (cache-files.ts).

import { clearDecodeCache } from '@stxapps/shared';

import { clearCacheFiles } from './cache-files';
import {
  favicons,
  getDb,
  itemFacetStatuses,
  items,
  itemTagIds,
  localSettings,
  locks,
  pendingOps,
  reviewPrompt,
  scrubFreedPages,
  sidebarView,
  subscriptionStatus,
  syncMeta,
} from './db';
import { clearFaviconFiles } from './favicon-store';
import { clearDataFiles } from './file-store';
import { invalidateLiveReads } from './live-read-invalidation';
import { clearShareData } from './share-store';

export async function clearData(): Promise<void> {
  getDb().transaction((tx) => {
    tx.delete(items).run();
    tx.delete(itemTagIds).run();
    tx.delete(itemFacetStatuses).run();
    tx.delete(syncMeta).run();
    tx.delete(pendingOps).run();
    tx.delete(localSettings).run();
    // Locks are device-local passwords for this account's session; wiping them
    // here IS the "forgot a lock password → sign out" recovery path (db.ts).
    tx.delete(locks).run();
    // The device's last-known subscription copy — same "next account must not
    // inherit this one's state" reason as localSettings (subscription-store.ts).
    tx.delete(subscriptionStatus).run();
    // The favicon cache: no icon is a secret, but the SET of hosts is the
    // account's browsing shape (db.ts `favicons` — web's rule, verbatim).
    tx.delete(favicons).run();
    // The links-drawer collapse state — its ids are this account's list/tag ids,
    // so the next account must not inherit them (db.ts `sidebar_view`). A device
    // store like localSettings, so it's wiped here on sign-out but NOT by
    // delete-all-data (which keeps device/identity stores).
    tx.delete(sidebarView).run();
    // The review-prompt bookkeeping (db.ts `review_prompt`). Nothing in it is the
    // account's, but "sign-out leaves nothing behind" is simpler to hold with no
    // exceptions, and the OS caps the prompt per install whatever this says.
    // The cost is that our own caps start over at the next sign-in.
    tx.delete(reviewPrompt).run();
  });
  // Bare whole-table deletes take SQLite's truncate optimization, which does
  // not invoke the sqlite3_update_hook behind expo-sqlite's change listener
  // (delete-all-data.ts, same note). The signed-in subtree is already unmounted
  // by the time this runs, but a reader mounted ABOVE the auth gate is not: the
  // root ThemeProvider reads `items` + `local_settings` through useSettings and
  // would otherwise keep the signed-out account's theme pinned — over the
  // landing, and into the next account in this process — until a relaunch.
  // Every wiped table is named rather than just those two, so the next reader
  // hoisted above the gate needs no entry here. Before the file deletes, so a
  // file-system throw can't skip it.
  invalidateLiveReads([
    'items',
    'item_tag_ids',
    'item_facet_statuses',
    'sync_meta',
    'pending_ops',
    'local_settings',
    'locks',
    'subscription_status',
    'favicons',
    'sidebar_view',
    'review_prompt',
  ]);
  // The deletes above only unlink pages: the decrypted rows are still in the
  // database FILE until it is rebuilt (db.ts, scrubFreedPages).
  scrubFreedPages();
  // Decrypted `files/` blobs on disk — mirrors the items wipe (file-store.ts).
  clearDataFiles();
  // Cached icon files — the file half of the favicons wipe (favicon-store.ts;
  // same tables-first fail-safe ordering).
  clearFaviconFiles();
  // The share sheet's App Group artifacts (iOS taxonomy snapshot + outbox) —
  // they name the account's lists/tags and may hold undrained URLs — and, on
  // Android, the handoff markers its share activity left: this account's link
  // ids (share-store.ts).
  clearShareData();
  // Plaintext left in the OS cache dir, which nothing above reaches — an export,
  // an import's picked copy, a custom image's picked file (cache-files.ts).
  clearCacheFiles();
  clearDecodeCache(); // drop decoded-link plaintext too (@stxapps/shared decode-cache)
}
