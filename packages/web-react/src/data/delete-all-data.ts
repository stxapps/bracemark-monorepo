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
  clearDecodeCache,
  dataDeleteAllEndpoint,
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  withTimeout,
} from '@stxapps/shared';

import { awaitInflightSync } from '../sync/engine';
import { db } from './db';
import { clearPendingOps } from './pending-store';
import { seedNewAccount } from './sync-store';

export type DeleteAllOutcome = {
  // R2 objects the server removed — the receipt line. 0 is a valid outcome.
  deletedCount: number;
};

export type DeleteAllStep = 'waiting-for-sync' | 'deleting';

// A cap on how long this user-initiated action spins, not an estimate of how
// long a cycle takes. The per-request deadlines (shared's `withDeadline`: the
// contract client's default call deadline, the R2 blob transfers') don't make it
// redundant. They guarantee the cycle settles EVENTUALLY, and eventually has no
// bound a user can sit through: a cycle is many requests in sequence, each with
// its own deadline; a 429/5xx still retries through its Retry-After wait; a sync
// triggered meanwhile reruns inside the same in-flight cycle; and the Dexie and
// crypto work has no deadline at all. The cap is one stalled call's deadline
// plus the retry client's longest single wait (two minutes today) — room for the
// worst single hiccup, derived so that moving either one moves this. Longer only
// lengthens the spinner, because giving up is cheap: timing out FAILS CLOSED
// below (no queue clear, server wipe, or local wipe follows) and cancels nothing,
// so the cycle runs on and a retry resumes the wait on it.
//
// The duration and the wording live HERE, not in the engine: the watchdog is a
// property of this destructive, user-blocking action, not of waiting itself —
// `awaitInflightSync` deliberately never rejects, and it also serves the
// bracemark-extension's background worker, which has no UI to show a message to.
// shared's `withTimeout` supplies the mechanism and nothing else.
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

  // Quiesce before destroying: a cycle already in flight read the pending queue
  // before we got here and could re-push (resurrect) ops after the server wipe —
  // wait it out, THEN abandon the queue so any later cycle finds nothing to push.
  // (This device's unsynced changes are deliberately discarded: the user is
  // deleting everything, so pushing them first would be work the wipe undoes.)
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
  // items, their decoded-plaintext cache, and the locks (they guard lists that
  // no longer exist — same reset clearData applies, and the empty library needs
  // no shoulder-surfing gate until new locks are set). The favicon cache goes too:
  // it isn't synced state, but it's derived FROM the wiped links, so leaving it
  // would let the deleted library's hosts be read back off the device.
  await Promise.all([db.items.clear(), db.locks.clear(), db.favicons.clear()]);
  clearDecodeCache();

  // Reset the sync bookkeeping to the seeded-new-account state: cursor (0, '')
  // with firstSyncDoneAt now — semantically exact, because an empty local store
  // IS the complete snapshot of the wiped namespace (the same reasoning that
  // lets create-account seed instead of pulling). The next cycle is one empty
  // ops/list call, not a re-download.
  await seedNewAccount(username);

  return { deletedCount };
}
