'use client';

// The delete-all-data flow (Settings → Data → Delete): one server call wipes the
// whole data plane (POST /v1/data/delete-all — the R2 namespace, the op log, the
// quota map), then the device-local synced state is wiped to match. The SESSION
// and the cached subscription copy deliberately survive — this deletes the
// user's data, not their account (that's delete-account in the Account section)
// — which is exactly the line that separates this from clearData (clear-data.ts,
// the sign-out teardown): same wipe of the synced stores, opposite treatment of
// the identity stores. Device-local settings (localSettings — theme/layout
// device overrides) also survive: they're this device's preferences, not "your
// data", and the synced settings/general.enc they override IS wiped server-side.
//
// Other devices need nothing from us: the wiped op log answers their next pull
// with null bounds, routing them into the download-authoritative fallback
// against the empty namespace, which deletes their local copies (see
// docs/data-lifecycle.md). A device holding UNSYNCED changes will push those
// back afterward (local-wins, the same policy as every fallback) — the UI copy
// says so.

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
import { db } from './db';
import { clearPendingOps } from './pending-store';
import { AccountFencedError, resetToSeededState } from './sync-store';

export type DeleteAllOutcome = {
  // R2 objects the server removed — the receipt line. 0 is a valid outcome.
  deletedCount: number;
};

export type DeleteAllStep = 'waiting-for-sync' | 'deleting';

// A cap on how long this user-initiated action waits for a sync to finish, not
// an estimate of how long a cycle takes. The per-request deadlines (shared's
// `withDeadline`: the contract client's default call deadline, the R2 blob
// transfers') don't make it redundant. They guarantee the cycle settles
// EVENTUALLY, and eventually has no bound a user can sit through: a cycle is many
// requests in sequence, each with its own deadline; a 429/5xx still retries
// through its Retry-After wait; and the Dexie and crypto work has no deadline at
// all. The cap is one stalled call's deadline plus the retry client's longest
// single wait (two minutes today) — room for the worst single hiccup, derived so
// that moving either one moves this. Longer only lengthens the spinner, because
// giving up is cheap: timing out FAILS CLOSED (no server wipe or local wipe
// follows) and cancels nothing, so the cycle runs on and a retry waits again.
//
// It bounds the WAIT and nothing after it: the clock stops the moment the hold
// is taken, because the server call that follows has its own, longer deadline
// (DELETE_ALL_TIMEOUT_MS in its contract) and a watchdog running over it would
// report a failure for a wipe that is still going.
//
// The duration and the wording live HERE, not in the engine: the watchdog is a
// property of this destructive, user-blocking action, not of waiting itself —
// `holdSyncCycles` takes a signal and has no clock of its own.
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
  // holds this account's sync cycles off (sync/engine.ts holdSyncCycles — the
  // cycle lock, so other tabs' cycles too). A cycle beside the server wipe would
  // read the pending queue and push it past the wipe, bringing back what the user
  // deleted; one that pulled while the call was out would land server copies over
  // edits the wipe was then refused for. Held off, the queue simply stays where it
  // is until the server answers — no cycle can see it. On success this device's
  // unsynced changes are discarded on purpose (pushing them first would be work
  // the wipe undoes).
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
  // It NAMES the account, and that is what binds it. `username` was captured at
  // the click; the bearer token is attached by the client as the request leaves
  // (lib/auth-api-client.ts reads the session then), and the wait above is long
  // enough for the session to have become someone else's — another tab signs in
  // as a different account and this one adopts it in place. The server wipes only
  // if the token's account is the one named, so that request is refused instead
  // of emptying the next account's namespace (shared's data/endpoints.ts). No
  // check HERE can replace it: "compare the session, then send" holds only while
  // nothing between the two awaits, and nothing would report the day one does.
  let deletedCount: number;
  try {
    ({ deletedCount } = await api.call(dataDeleteAllEndpoint, { username }));
  } catch (e) {
    if (apiErrorCode(e) === DATA_DELETE_ALL_ERROR.accountMismatch) {
      throw new DeleteAllAccountChangedError(false);
    }
    // A 4xx is a refusal the route gave before touching anything (the name
    // check, validation, auth, a rate limit): nothing was wiped, and the queue
    // stays — "nothing was removed" is true of it too. Anything else (a timeout,
    // a lost response, a 5xx) leaves no telling whether the wipe ran: the route
    // empties the op log before it pages R2, and only answers after the last
    // page. Kept, the queue would push into a namespace that may already be empty
    // and bring back what the user asked to delete, so it goes, as it would on
    // success; the failure line says so. Best-effort: the call's own error is
    // the one to report.
    if (!(e instanceof ApiError && e.status >= 400 && e.status < 500)) {
      await clearPendingOps(username).catch(() => undefined);
      throw new DeleteAllUncertainError(e);
    }
    throw e;
  }

  // Local synced state, wiped to match the (now empty) server: the decrypted
  // items, their decoded-plaintext cache, the pending queue, and the locks (they
  // guard lists that no longer exist — same reset clearData applies, and the
  // empty library needs no shoulder-surfing gate until new locks are set). The
  // favicon cache goes too: it isn't synced state, but it's derived FROM the
  // wiped links, so leaving it would let the deleted library's hosts be read
  // back off the device.
  //
  // And the sync bookkeeping, reset to the seeded-new-account state: cursor
  // (0, '') with firstSyncDoneAt now — semantically exact, because an empty local
  // store IS the complete snapshot of the wiped namespace (the same reasoning
  // that lets create-account seed instead of pulling). The next cycle is one
  // empty ops/list call, not a re-download.
  //
  // ONE TRANSACTION, FENCED ON THE ACCOUNT, and the reset goes first because it
  // is the fence (sync-store.ts). The call above pages the whole namespace and
  // can be out for minutes, and this tab is not the only context that can end
  // the session meanwhile: another tab signs out, or signs in as someone else.
  // None of these tables has an owner column, so run blind this would empty the
  // NEXT account's library, locks and icons, and then write the previous
  // account's ownership row back beside the new one. Sharing the teardown's
  // scope (clear-data.ts) is what orders the two: this lands first and the
  // teardown wipes what it left, or the teardown's clear lands first and this
  // finds no row and throws with nothing touched. The fence is the ROW, keyed on
  // the username and not on the session, so two orderings still pass it, both
  // on the starting account's own data: the same username signed back in while
  // the call was out, and a teardown whose clear failed and left the row.
  //
  // A refusal is reported as what it is. By here the server HAS wiped the account
  // that asked, so the fence's own error — a sync error, about a sync that
  // stopped — would read as a delete that failed and could be tried again.
  try {
    await db.transaction(
      'rw',
      [db.syncMeta, db.items, db.pendingOps, db.locks, db.favicons],
      async () => {
        await resetToSeededState(username);
        await Promise.all([
          db.items.clear(),
          db.pendingOps.where('username').equals(username).delete(),
          db.locks.clear(),
          db.favicons.clear(),
        ]);
      },
    );
  } catch (e) {
    if (e instanceof AccountFencedError) throw new DeleteAllAccountChangedError(true);
    throw e;
  }
  clearDecodeCache();

  return { deletedCount };
}
