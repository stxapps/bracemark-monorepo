// The delete-all-data flow — the expo sibling of web-react's
// data/delete-all-data.ts, same shape and the same line it draws (see there
// for the full rationale): one server call wipes the whole data plane, then
// the device-local SYNCED state is wiped to match, while the session, the
// cached subscription copy, and the device-local settings survive — this
// deletes the user's data, not their account or this device's preferences.
// That's exactly what separates it from clearData (clear-data.ts, the
// sign-out teardown): same wipe of the synced stores, opposite treatment of
// the identity/device stores.

import { type ApiClient, clearDecodeCache, dataDeleteAllEndpoint } from '@stxapps/shared';

import { awaitInflightSync } from '../sync/engine';
import { favicons, getDb, itemFacetStatuses, items, itemTagIds, locks } from './db';
import { clearFaviconFiles } from './favicon-store';
import { clearDataFiles } from './file-store';
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

  // Quiesce before destroying: a cycle that already read the pending queue
  // could re-push (resurrect) ops after the server wipe — wait it out, THEN
  // abandon the queue so any later cycle finds nothing to push. (This device's
  // unsynced changes are deliberately discarded: the user is deleting
  // everything, so pushing them first would be work the wipe undoes.)
  await awaitInflightSync(username);
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

  // Reset the sync bookkeeping to the seeded-new-account state: cursor (0, '')
  // with firstSyncDoneAt now — semantically exact, because an empty local store
  // IS the complete snapshot of the wiped namespace (the same reasoning that
  // lets create-account seed instead of pulling). The next cycle is one empty
  // ops/list call, not a re-download.
  await seedNewAccount(username);

  return { deletedCount };
}
