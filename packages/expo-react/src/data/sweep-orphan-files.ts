// The orphaned-file janitor — web-react's data/sweep-orphan-files.ts, whose header
// carries the design and every condition with its reason. ⚠ IT DELETES USER DATA
// ON EVERY DEVICE when it is wrong. The rules (the gate, the candidates, what
// counts as a reference, the cap) are shared's sync/sweeps.ts, so this file and
// web's run one copy of them. This file keeps the store reads and the deletes, and
// the conditions that are about reading this store:
//
//   - WHO and WHEN: a full-sync client, at the end of a SUCCESSFUL cycle, inside
//     its lock (SyncProviderWithSweep, through the engine's afterCycle), so the
//     store is the whole library and no pull is half-landed.
//   - THE WHOLE STORE IS READ. Every entity row's bytes, a page at a time; a row
//     with no bytes, or bytes that aren't JSON, stops the run. Entity rows always
//     carry their bytes here (only `files/` rows keep theirs on disk), so a row
//     without them is a store this can't vouch for.
//   - NOTHING WRITTEN DURING THE SCAN. The scan yields between pages, and the
//     cycle lock only holds off cycles: a local edit, the Android share activity
//     (same process, same database) or the iOS share outbox's drain can write an
//     entity meanwhile that names an old blob. Every such write queues an op, so
//     comparing the queue before and after catches it, and the run stops.
//
// The candidate read is a key-and-stamp scan of `files/` (no index on
// `updated_at` here, on purpose — db.ts), once a week at most.

import {
  entityWrittenDuring,
  FILES_PREFIX,
  orphanCandidates,
  orphansToDelete,
  orphanSweepMayRun,
  orphanSweepStamp,
  pendingWrites,
  strikeEntityReferences,
} from '@stxapps/shared';

import { yieldToMain } from '../lib/yield-to-main';
import { entityRowsPage, namespaceStamps } from './item-store';
import { deleteFile } from './mutations';
import { listPendingOps } from './pending-store';
import { getSyncMeta, markOrphanSweep } from './sync-store';

// Entity rows decoded per page of the scan, between yields.
const SCAN_PAGE = 500;

// Sweep orphaned `files/` blobs: delete each locally (row and plaintext file) and
// queue the server delete. Returns how many were swept, so the caller knows whether
// to run the cycle once more to push the deletes.
export async function sweepOrphanFiles(username: string, now = Date.now()): Promise<number> {
  if (!orphanSweepMayRun(await getSyncMeta(username), now)) return 0;

  const queue = async () => pendingWrites(await listPendingOps(username));
  const before = await queue();
  const candidates = orphanCandidates(namespaceStamps(FILES_PREFIX), before, now);

  if (candidates.size > 0) {
    const decoder = new TextDecoder();
    let after = '';
    while (candidates.size > 0) {
      const rows = entityRowsPage(after, SCAN_PAGE);
      if (rows.length === 0) break;
      for (const row of rows) {
        // A record that can't be read stops the run: nothing is provable then.
        if (!strikeEntityReferences(row.data, candidates, decoder)) return 0;
      }
      after = rows[rows.length - 1].path;
      await yieldToMain();
    }
    // An entity write landed while we scanned: its references weren't seen.
    if (entityWrittenDuring(before, await queue())) return 0;
  }

  const ids = orphansToDelete(candidates);
  let swept = 0;
  for (const fileId of ids) {
    await deleteFile(username, fileId);
    swept += 1;
  }
  // Recorded only for a run that got to the end — an unprovable store tries again
  // next session rather than waiting a week. A run the cap cut short is stamped to
  // come back in a day, not a week (shared's orphanSweepStamp).
  await markOrphanSweep(username, orphanSweepStamp(now, candidates.size > ids.length));
  return swept;
}
