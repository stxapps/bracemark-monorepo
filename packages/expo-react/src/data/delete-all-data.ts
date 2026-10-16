// The delete-all-data flow — the expo sibling of web-react's
// data/delete-all-data.ts, same shape and the same line it draws (see there
// for the full rationale): one server call wipes the whole data plane, then
// the device-local SYNCED state is wiped to match, while the session, the
// cached subscription copy, and the device-local settings survive — this
// deletes the user's data, not their account or this device's preferences.
// That's exactly what separates it from clearData (clear-data.ts, the
// sign-out teardown): same wipe of the synced stores, opposite treatment of
// the identity/device stores.

import { eq } from 'drizzle-orm';

import {
  type ApiClient,
  ApiError,
  apiErrorCode,
  clearDecodeCache,
  DATA_DELETE_ALL_ERROR,
  dataDeleteAllEndpoint,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  DeleteAllAccountChangedError,
  DeleteAllUncertainError,
} from '@stxapps/shared';

import { holdSyncCycles } from '../sync/engine';
import {
  favicons,
  getDb,
  itemFacetStatuses,
  items,
  itemTagIds,
  locks,
  pendingOps,
  scrubFreedPages,
} from './db';
import { clearFaviconFiles } from './favicon-store';
import { clearDataFiles } from './file-store';
import { invalidateLiveReads } from './live-read-invalidation';
import { clearPendingOps } from './pending-store';
import { AccountFencedError, resetToSeededStateTx } from './sync-store';

export type DeleteAllOutcome = {
  // R2 objects the server removed — the receipt line. 0 is a valid outcome.
  deletedCount: number;
};

export type DeleteAllStep = 'waiting-for-sync' | 'deleting';

// A cap on how long this user-initiated action waits for a sync to finish, not
// an estimate of how long a cycle takes. The per-request deadlines (the contract
// client's default call deadline, `withDeadline` on the JS R2 transfers, the OS
// idle timeouts on the native ones) don't make it redundant. They guarantee the
// cycle settles EVENTUALLY, and the web sibling spells out why eventually has no
// bound a user can sit through. The cap is one stalled call's deadline plus the
// retry client's longest single wait (two minutes today), derived from both.
// Timing out FAILS CLOSED (no server wipe or local wipe follows) and cancels
// nothing, so the cycle runs on and a retry waits again. It bounds the wait
// only: the clock stops once the hold is taken, before the server call, which
// has its own longer deadline.
//
// The duration and the wording live HERE, not in the engine, for the reason the
// web sibling spells out: the watchdog is a property of this destructive,
// user-blocking action, not of waiting itself — `holdSyncCycles` takes a signal
// and has no clock of its own.
const SYNC_WAIT_TIMEOUT_MS = DEFAULT_CALL_TIMEOUT_MS + DEFAULT_RETRY_MAX_DELAY_MS;
const SYNC_WAIT_TIMEOUT_MESSAGE = 'Sync is taking longer than expected.';

export async function deleteAllData(args: {
  username: string;
  api: ApiClient;
  onStep?: (step: DeleteAllStep) => void;
  /** Test seam; production uses the two-minute safety watchdog. */
  syncWaitTimeoutMs?: number;
}): Promise<DeleteAllOutcome> {
  const { username, api, onStep, syncWaitTimeoutMs = SYNC_WAIT_TIMEOUT_MS } = args;

  // Quiesce before destroying, and STAY quiet until it is over: the whole run
  // holds this account's sync cycles off (sync/engine.ts holdSyncCycles). A cycle
  // beside the server wipe would push the pending queue past it, or pull server
  // copies over edits the wipe was then refused for (the web sibling spells it
  // out). Held off, the queue stays where it is until the server answers. On
  // success this device's unsynced changes are discarded on purpose.
  const watchdog = new AbortController();
  const syncWaitTimer = setTimeout(() => watchdog.abort(), syncWaitTimeoutMs);
  try {
    return await holdSyncCycles(
      username,
      () => {
        clearTimeout(syncWaitTimer);
        onStep?.('deleting');
        return wipe(username, api);
      },
      { onWait: () => onStep?.('waiting-for-sync'), signal: watchdog.signal },
    );
  } catch (e) {
    if (watchdog.signal.aborted) throw new Error(SYNC_WAIT_TIMEOUT_MESSAGE);
    throw e;
  } finally {
    clearTimeout(syncWaitTimer);
  }
}

// The server wipe, then the local one — with no sync cycle able to run beside
// either (deleteAllData holds them off).
async function wipe(username: string, api: ApiClient): Promise<DeleteAllOutcome> {
  // The server wipe — idempotent, so a failure here leaves everything retryable,
  // and the local wipe below only runs after the server confirms.
  //
  // It NAMES the account, and that is what binds it: `username` was captured at
  // the tap, the bearer token is attached as the request leaves, and the server
  // wipes only if the token's account is the one named — so a session that became
  // someone else's during the wait above is refused instead of losing its
  // namespace (the web sibling and shared's data/endpoints.ts carry the reasoning).
  let deletedCount: number;
  try {
    ({ deletedCount } = await api.call(dataDeleteAllEndpoint, { username }));
  } catch (e) {
    if (apiErrorCode(e) === DATA_DELETE_ALL_ERROR.accountMismatch) {
      throw new DeleteAllAccountChangedError(false);
    }
    // A 4xx refused before anything was touched, and the queue stays. Anything
    // else leaves no telling whether the wipe ran, so the queue goes rather than
    // push into a namespace that may be empty (the web sibling spells it out).
    if (!(e instanceof ApiError && e.status >= 400 && e.status < 500)) {
      await clearPendingOps(username).catch(() => undefined);
      throw new DeleteAllUncertainError(e);
    }
    throw e;
  }

  // Local synced state, wiped to match the (now empty) server: the decrypted
  // items (rows + their junction tables + the on-disk plaintext blobs), their
  // decoded-plaintext cache, the pending queue, and the locks (they guard lists that no longer
  // exist — same reset clearData applies). The favicon cache goes too: it isn't
  // synced state, but it's derived FROM the wiped links, so leaving it would
  // let the deleted library's hosts be read back off the device (web's rule).
  //
  // And the sync bookkeeping, reset to the seeded-new-account state: cursor
  // (0, '') with firstSyncDoneAt now — semantically exact, because an empty local
  // store IS the complete snapshot of the wiped namespace (the same reasoning
  // that lets create-account seed instead of pulling). The next cycle is one
  // empty ops/list call, not a re-download.
  //
  // ONE TRANSACTION, FENCED ON THE ACCOUNT, and the reset goes first because it
  // is the fence (sync-store.ts): the call above can be out for minutes, and a
  // session that ended under it may have been followed by another account's
  // sign-in. None of these tables has an owner column, so run blind this would
  // empty the NEXT account's library and then write the previous account's
  // ownership row back beside the new one (the web sibling spells it out). A
  // throw here also skips everything below, which is the point: the file sweeps
  // are no more account-scoped than the tables.
  //
  // A refusal is reported as what it is: by here the server HAS wiped the account
  // that asked, and the fence's own error is a sync error (the web sibling).
  try {
    getDb().transaction((tx) => {
      resetToSeededStateTx(tx, username);
      tx.delete(items).run();
      tx.delete(itemTagIds).run();
      tx.delete(itemFacetStatuses).run();
      tx.delete(pendingOps).where(eq(pendingOps.username, username)).run();
      tx.delete(locks).run();
      tx.delete(favicons).run();
    });
  } catch (e) {
    if (e instanceof AccountFencedError) throw new DeleteAllAccountChangedError(true);
    throw e;
  }
  // "Delete all data" has to mean the file too, not just the tables (db.ts).
  scrubFreedPages();
  clearDataFiles();
  clearFaviconFiles();
  clearDecodeCache();
  // NOT clearCacheFiles, the one member of clearData's set this deliberately
  // leaves: the export in the cache dir may be the backup the user took a
  // minute ago BECAUSE they were about to do this, and the app they sent it to
  // can still be reading it. After a sign-out the server has the library; after
  // this, that file may be the only copy. It goes with the next export or the
  // sign-out (cache-files.ts).
  // Bare whole-table deletes take SQLite's truncate optimization, which does
  // not invoke the sqlite3_update_hook behind expo-sqlite's change listener.
  // Newly mounted readers would see the empty tables while already-mounted
  // links/sidebar/lock/favicon readers kept their old snapshots. Explicitly
  // invalidate once after the transaction instead of turning a large wipe
  // into one native event per deleted row.
  invalidateLiveReads(['items', 'item_tag_ids', 'item_facet_statuses', 'locks', 'favicons']);

  return { deletedCount };
}
