'use client';

// The orphaned-file janitor: `files/{id}.enc` blobs that NOTHING in the library
// references any more. They cost the user's byte quota on every device and nothing
// else reclaims them — every other path to a blob goes THROUGH a reference (destroy,
// the dangling-extraction sweep, writeExtraction's replaced-blob reclaim), so a blob
// whose reference is gone is invisible to all of them. How one gets orphaned now that
// the replaced-blob reclaim exists: two devices capture the same copy in one sync
// window and LWW keeps one extraction (the other's blob loses its ref); a device
// uploads a blob and never pushes the extraction that points at it; and builds from
// before the reclaim, which left every replaced blob behind.
// docs/link-extraction-keep.md, _removal, cleanup, export_.
//
// ⚠ THIS DELETES USER DATA ON EVERY DEVICE when it is wrong, which is why it is far
// more conservative than the dangling sweep it runs beside — a wrongly swept
// extraction re-extracts, a wrongly swept custom image or kept copy is gone. Every
// condition below is load-bearing:
//
//   - WHO and WHEN: the dangling sweep's conditions, all of them (that file's header):
//     a full-sync client, at the end of a SUCCESSFUL cycle, inside its lock — so the
//     store is the whole library, not a pull half-landed or a selective subset.
//   - NO UNREADABLE PATHS AT ALL. Where the dangling sweep spares the one extraction
//     whose link was skipped, this one cannot tell which blob a skipped entity
//     pointed at, so any recorded skip stops the whole run.
//   - "REFERENCED" MEANS ANY STRING IN ANY ENTITY, not the fields this build knows.
//     A newer client may add a field — or a namespace — that names a blob; a sweep
//     that asked only EXTRACTION_FILE_REF_FIELDS and `customImageId` would delete
//     that client's blobs for everyone, the selective-sync hazard in a new form. So
//     every non-file entity is decoded and every string in it, at any depth, counts
//     as a reference — an object's keys as much as its values, since a newer client
//     may keep a map keyed by blob id. A record that won't decode, or has no bytes,
//     stops the run.
//   - NEVER A BLOB WITH A PENDING OP, and never one younger than ORPHAN_GRACE_MS.
//     Content is written before the reference that names it: on this device a
//     capture writes the blob, then the extraction, and another tab's capture can be
//     between the two while this runs (captures don't take the cycle lock). A local,
//     unpushed write also carries `updatedAt: 0` (its sync base) — the pending-op
//     check is what excludes it, not the age. Across devices, a device can push the
//     blob and stall before the extraction; the grace (a month) is how long it gets
//     to come back and push the rest.
//   - NOTHING WRITTEN DURING THE SCAN. The scan yields, and another tab (or an
//     import) can write an entity meanwhile that names an old blob — a restore that
//     skips a blob already stored, say. Any entity put queued between the start and
//     the end of the scan aborts the run instead of trusting a stale answer.
//   - BOUNDED: at most once a week per account on this device
//     (`SyncMetaRecord.lastOrphanSweepAt`), at most ORPHAN_SWEEP_MAX deletes a run,
//     yielding to the main thread between chunks of the scan. A run that hit the
//     cap comes back in a day instead (ORPHAN_SWEEP_BACKLOG_INTERVAL_MS): at 500 a
//     week, an account full of blobs older builds leaked stayed at its ceiling for
//     months.
//
// The dangling sweep's KNOWN GAPS apply here too and cost more: a successful cycle
// can still lack an entity the server holds (a skip by a tab still running a build
// older than the unreadable record, an op log restored beneath the cursor, a wedged
// queued put — a store whose row predates the record is held off by the gate, as in
// the dangling sweep), and
// a blob only that entity names would be swept. The grace does not cover that case.
// Accepted with the same eyes open as the dangling sweep — those states are exotic,
// and an orphan costs quota forever — but it is the reason for every condition above.

import {
  entityWrittenDuring,
  FILES_PREFIX,
  ORPHAN_GRACE_MS,
  orphanCandidates,
  orphanGraceNow,
  orphansToDelete,
  orphanSweepMayRun,
  orphanSweepStamp,
  pendingWrites,
  strikeEntityReferences,
} from '@stxapps/shared';

import { yieldToMain } from '../lib/yield-to-main';
import { db } from './db';
import { deleteFile } from './mutations';
import { getSyncMeta, markOrphanSweep } from './sync-store';

// Entities decoded per chunk of the scan, between yields.
const SCAN_CHUNK = 500;

// Sweep orphaned `files/` blobs: delete each locally and queue the server delete.
// Returns how many were swept, so the caller knows whether to run another cycle to
// push the deletes. The rules (the gate, the candidates, what counts as a reference,
// the cap) are shared's sync/sweeps.ts, which expo's sweep runs too; this keeps the
// store reads and the deletes.
export async function sweepOrphanFiles(username: string, now = Date.now()): Promise<number> {
  const meta = await getSyncMeta(username);
  if (!orphanSweepMayRun(meta, now)) return 0;
  // The grace runs on the server's clock as far as this device knows it, not on this
  // device's (shared's orphanGraceNow).
  const graceNow = orphanGraceNow(now, meta);

  // Candidates: old enough by their SERVER stamp, and with nothing queued for their
  // path. The index range is only the cheap first cut; orphanCandidates applies the
  // rule.
  const fileRows: { path: string; updatedAt: number }[] = [];
  await db.items
    .where('updatedAt')
    .between(0, graceNow - ORPHAN_GRACE_MS, false, false)
    .eachKey((updatedAt, cursor) => {
      const path = cursor.primaryKey as string;
      if (path.startsWith(FILES_PREFIX)) fileRows.push({ path, updatedAt: updatedAt as number });
    });
  const queue = async () =>
    pendingWrites(await db.pendingOps.where('username').equals(username).toArray());
  const before = await queue();
  const candidates = orphanCandidates(fileRows, before, graceNow);

  if (candidates.size > 0) {
    const entityPaths = (await db.items.toCollection().primaryKeys()).filter(
      (path) => !path.startsWith(FILES_PREFIX),
    );
    const decoder = new TextDecoder();
    for (let i = 0; i < entityPaths.length && candidates.size > 0; i += SCAN_CHUNK) {
      const records = await db.items.bulkGet(entityPaths.slice(i, i + SCAN_CHUNK));
      for (const record of records) {
        if (!record) continue; // deleted since the key scan — it references nothing now
        // A record that can't be read stops the run: nothing is provable then.
        if (!strikeEntityReferences(record.data, candidates, decoder)) return 0;
      }
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
