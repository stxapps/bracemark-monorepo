// The delete-all-data flow — the expo sibling of web-react's
// data/delete-all-data.ts, same shape and the same line it draws (see there
// for the full rationale): one server call wipes the whole data plane, then
// the device-local SYNCED state is wiped to match, while the session, the
// cached subscription copy, and the device-local settings survive — this
// deletes the user's data, not their account or this device's preferences.
// That's exactly what separates it from clearData (clear-data.ts, the
// sign-out teardown): same wipe of the synced stores, opposite treatment of
// the identity/device stores.

import {
  type ApiClient,
  clearDecodeCache,
  dataDeleteAllEndpoint,
  withTimeout,
} from '@stxapps/shared';

import { awaitInflightSync } from '../sync/engine';
import { favicons, getDb, itemFacetStatuses, items, itemTagIds, locks } from './db';
import { clearFaviconFiles } from './favicon-store';
import { clearDataFiles } from './file-store';
import { invalidateLiveReads } from './live-read-invalidation';
import { clearPendingOps } from './pending-store';
import { seedNewAccount } from './sync-store';

export type DeleteAllOutcome = {
  // R2 objects the server removed — the receipt line. 0 is a valid outcome.
  deletedCount: number;
};

export type DeleteAllStep = 'waiting-for-sync' | 'deleting';

// Allows the retry client's normal one-minute Retry-After window to settle, but
// stays finite: a fetch or retry wait that never resolves must not leave this
// user-initiated action spinning forever. Timing out FAILS CLOSED below — no
// queue clear, server wipe, or local wipe follows.
//
// The duration and the wording live HERE, not in the engine, for the reason the
// web sibling spells out: the watchdog is a property of this destructive,
// user-blocking action, not of waiting itself — `awaitInflightSync` deliberately
// never rejects. shared's `withTimeout` supplies the mechanism and nothing else.
const SYNC_WAIT_TIMEOUT_MS = 120_000;
const SYNC_WAIT_TIMEOUT_MESSAGE = 'Sync is taking longer than expected.';

export async function deleteAllData(args: {
  username: string;
  api: ApiClient;
  onStep?: (step: DeleteAllStep) => void;
  /** Test seam; production uses the two-minute safety watchdog. */
  syncWaitTimeoutMs?: number;
}): Promise<DeleteAllOutcome> {
  const { username, api, onStep, syncWaitTimeoutMs = SYNC_WAIT_TIMEOUT_MS } = args;

  // Quiesce before destroying: a cycle that already read the pending queue
  // could re-push (resurrect) ops after the server wipe — wait it out, THEN
  // abandon the queue so any later cycle finds nothing to push. (This device's
  // unsynced changes are deliberately discarded: the user is deleting
  // everything, so pushing them first would be work the wipe undoes.)
  await withTimeout(
    awaitInflightSync(username, () => onStep?.('waiting-for-sync')),
    syncWaitTimeoutMs,
    SYNC_WAIT_TIMEOUT_MESSAGE,
  );
  onStep?.('deleting');
  await clearPendingOps(username);

  // The server wipe — idempotent, so a failure here leaves everything retryable
  // and nothing local has been touched yet (the local wipe below only runs after
  // the server confirms).
  const { deletedCount } = await api.call(dataDeleteAllEndpoint, {});

  // Local synced state, wiped to match the (now empty) server: the decrypted
  // items (rows + their junction tables + the on-disk plaintext blobs), their
  // decoded-plaintext cache, and the locks (they guard lists that no longer
  // exist — same reset clearData applies). The favicon cache goes too: it isn't
  // synced state, but it's derived FROM the wiped links, so leaving it would
  // let the deleted library's hosts be read back off the device (web's rule).
  getDb().transaction((tx) => {
    tx.delete(items).run();
    tx.delete(itemTagIds).run();
    tx.delete(itemFacetStatuses).run();
    tx.delete(locks).run();
    tx.delete(favicons).run();
  });
  clearDataFiles();
  clearFaviconFiles();
  clearDecodeCache();
  // Bare whole-table deletes take SQLite's truncate optimization, which does
  // not invoke the sqlite3_update_hook behind expo-sqlite's change listener.
  // Newly mounted readers would see the empty tables while already-mounted
  // links/sidebar/lock/favicon readers kept their old snapshots. Explicitly
  // invalidate once after the transaction instead of turning a large wipe
  // into one native event per deleted row.
  invalidateLiveReads(['items', 'item_tag_ids', 'item_facet_statuses', 'locks', 'favicons']);

  // Reset the sync bookkeeping to the seeded-new-account state: cursor (0, '')
  // with firstSyncDoneAt now — semantically exact, because an empty local store
  // IS the complete snapshot of the wiped namespace (the same reasoning that
  // lets create-account seed instead of pulling). The next cycle is one empty
  // ops/list call, not a re-download.
  await seedNewAccount(username);

  return { deletedCount };
}
