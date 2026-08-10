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

import { type ApiClient, clearDecodeCache, dataDeleteAllEndpoint } from '@stxapps/shared';

import { awaitInflightSync } from '../sync/engine';
import { db } from './db';
import { clearPendingOps } from './pending-store';
import { seedNewAccount } from './sync-store';

export type DeleteAllOutcome = {
  // R2 objects the server removed — the receipt line. 0 is a valid outcome.
  deletedCount: number;
};

export async function deleteAllData(args: {
  username: string;
  api: ApiClient;
}): Promise<DeleteAllOutcome> {
  const { username, api } = args;

  // Quiesce before destroying: a cycle already in flight read the pending queue
  // before we got here and could re-push (resurrect) ops after the server wipe —
  // wait it out, THEN abandon the queue so any later cycle finds nothing to push.
  // (This device's unsynced changes are deliberately discarded: the user is
  // deleting everything, so pushing them first would be work the wipe undoes.)
  await awaitInflightSync(username);
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
