// The dangling-extraction janitor — web-react's data/sweep-dangling-extractions.ts,
// whose header carries the whole design: what a dangling is (an extraction whose
// link a destroy on another device removed, brought back by a write-back that
// landed after it), why it's fixed by deletion, who may call it, and the known gaps.
// Which extractions are dangling is shared's danglingExtractionPaths, the one rule
// both platforms run. This file keeps the store reads and the deletes.
//
// THE READ IS ONE STATEMENT, where web's is two key scans: the store is asked for
// the extractions that have no link row (item-store's pathsWithoutShadow), not for
// every extraction path. The driver here is sync and this runs after the first
// cycle of every launch, so a read the size of the library would block the JS
// thread to find, nearly always, nothing. The shared rule still decides: it is
// handed those paths with no link present, and takes out the ones whose link a
// pull skipped as unreadable.
//
// WHO MAY CALL THIS: a full-sync client, at the end of a completed sync cycle and
// inside its lock (the engine's SyncDeps.afterCycle). bracemark-expo is a full-sync
// client and hands it to its SyncProvider (SyncProviderWithSweep), the same way
// bracemark-web does. No shared provider runs it by default.
//
// The expo half of a delete: deleteFile drops the plaintext file on disk with the
// row (mutations.ts), so a swept extraction's image, screenshot and page copy leave
// the device's storage too, not just the table.

import {
  danglingExtractionPaths,
  danglingSweepMayRun,
  extractionFileIds,
  EXTRACTIONS_PREFIX,
  idFromPath,
  LINKS_PREFIX,
} from '@stxapps/shared';

import { pathsWithoutShadow } from './item-store';
import { deleteExtraction, deleteFile } from './mutations';
import { readExtraction } from './queries';
import { getSyncMeta } from './sync-store';

// Sweep every dangling extraction: delete it (and its `files/` content) locally and
// queue the server deletes. Returns how many were swept, so the caller knows whether
// to run the cycle once more to push the tombstones.
export async function sweepDanglingExtractions(username: string): Promise<number> {
  // Not until the record can vouch for this store (shared's danglingSweepMayRun):
  // until a full listing has run with it in place, an absent link may be one an
  // older build skipped without recording.
  const meta = await getSyncMeta(username);
  if (!danglingSweepMayRun(meta ?? undefined)) return 0;
  // Links a pull skipped as unreadable: absent here, not proven absent there.
  const unreadable = new Set(meta?.unreadablePaths);
  // Only the extractions with no link row here, so `present` is empty by
  // construction and the rule's other half, the unreadable record, is what it
  // still has to apply.
  const linkless = pathsWithoutShadow(EXTRACTIONS_PREFIX, LINKS_PREFIX);
  if (linkless.length === 0) return 0;

  let swept = 0;
  for (const exPath of danglingExtractionPaths(linkless, new Set(), unreadable)) {
    // Content before entity, as destroy does: an interruption leaves the extraction
    // still dangling, with its refs intact, for the next run to finish.
    const linkId = idFromPath(exPath, EXTRACTIONS_PREFIX);
    const extraction = await readExtraction(linkId);
    for (const fileId of extractionFileIds(extraction)) await deleteFile(username, fileId);
    await deleteExtraction(username, linkId);
    swept += 1;
  }
  return swept;
}
