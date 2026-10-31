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
//     as a reference. A record that won't decode, or has no bytes, stops the run.
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
//     yielding to the main thread between chunks of the scan.
//
// The dangling sweep's KNOWN GAPS apply here too and cost more: a successful cycle
// can still lack an entity the server holds (a skip by a build older than the
// unreadable record, an op log restored beneath the cursor, a wedged queued put), and
// a blob only that entity names would be swept. The grace does not cover that case.
// Accepted with the same eyes open as the dangling sweep — those states are exotic,
// and an orphan costs quota forever — but it is the reason for every condition above.

import { FILES_PREFIX, idFromPath } from '@stxapps/shared';

import { yieldToMain } from '../lib/yield-to-main';
import { db } from './db';
import { deleteFile } from './mutations';
import { getSyncMeta, markOrphanSweep } from './sync-store';

// How old a blob's server stamp must be before it can count as orphaned.
export const ORPHAN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
// How often a device runs the sweep for an account. Each run decodes every entity.
export const ORPHAN_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// The most blobs one run deletes — a backlog clears over runs rather than in one
// burst of queued deletes.
export const ORPHAN_SWEEP_MAX = 500;
// Entities decoded per chunk of the scan, between yields.
const SCAN_CHUNK = 500;

// Stop the run: something in the store can't be read, so nothing can be proven
// unreferenced.
class Unprovable extends Error {}

// Every string at any depth of a decoded entity, against the candidates: a match is
// a reference, and the candidate leaves the set.
function strikeReferences(value: unknown, candidates: Set<string>): void {
  if (typeof value === 'string') {
    candidates.delete(value);
  } else if (Array.isArray(value)) {
    for (const item of value) strikeReferences(item, candidates);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) strikeReferences(item, candidates);
  }
}

// Sweep orphaned `files/` blobs: delete each locally and queue the server delete.
// Returns how many were swept, so the caller knows whether to run another cycle to
// push the deletes.
export async function sweepOrphanFiles(username: string, now = Date.now()): Promise<number> {
  const meta = await getSyncMeta(username);
  if (!meta || meta.firstSyncDoneAt <= 0) return 0;
  if (meta.unreadablePaths?.length) return 0;
  if (
    meta.lastOrphanSweepAt !== undefined &&
    now - meta.lastOrphanSweepAt < ORPHAN_SWEEP_INTERVAL_MS
  ) {
    return 0;
  }

  // Candidates: old enough by their SERVER stamp (> 0 — a local unpushed write is 0),
  // and with nothing queued for their path.
  const cutoff = now - ORPHAN_GRACE_MS;
  const oldPaths = (
    await db.items.where('updatedAt').between(0, cutoff, false, false).primaryKeys()
  ).filter((path) => path.startsWith(FILES_PREFIX));
  const pendingIds = async () =>
    new Set(
      (await db.pendingOps.where('username').equals(username).toArray()).map(
        (op) => `${op.path}\u0000${op.writeId}`,
      ),
    );
  const before = await pendingIds();
  const queued = new Set([...before].map((key) => key.slice(0, key.indexOf('\u0000'))));
  const candidates = new Set(
    oldPaths.filter((path) => !queued.has(path)).map((path) => idFromPath(path, FILES_PREFIX)),
  );

  if (candidates.size > 0) {
    try {
      const entityPaths = (await db.items.toCollection().primaryKeys()).filter(
        (path) => !path.startsWith(FILES_PREFIX),
      );
      const decoder = new TextDecoder();
      for (let i = 0; i < entityPaths.length && candidates.size > 0; i += SCAN_CHUNK) {
        const records = await db.items.bulkGet(entityPaths.slice(i, i + SCAN_CHUNK));
        for (const record of records) {
          if (!record) continue; // deleted since the key scan — it references nothing now
          if (!record.data) throw new Unprovable();
          let value: unknown;
          try {
            value = JSON.parse(decoder.decode(record.data));
          } catch {
            throw new Unprovable();
          }
          strikeReferences(value, candidates);
        }
        await yieldToMain();
      }
    } catch (err) {
      if (err instanceof Unprovable) return 0;
      throw err;
    }
    // An entity write landed while we scanned: its references weren't seen.
    for (const key of await pendingIds()) {
      if (!before.has(key) && !key.startsWith(FILES_PREFIX)) return 0;
    }
  }

  let swept = 0;
  for (const fileId of candidates) {
    if (swept >= ORPHAN_SWEEP_MAX) break;
    await deleteFile(username, fileId);
    swept += 1;
  }
  // Recorded only for a run that got to the end — an unprovable store tries again
  // next session rather than waiting a week.
  await markOrphanSweep(username, now);
  return swept;
}
