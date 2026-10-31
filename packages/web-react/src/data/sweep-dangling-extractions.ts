'use client';

// The dangling-extraction janitor. A DANGLING extraction is an `extractions/{id}.enc`
// whose `links/{id}.enc` no longer exists — minted by the writer-split's one delete
// race: device A destroys a link (deleting link + extraction + files together, see
// useLinkMutations.destroy) while device B still has an extraction write-back for it
// in flight or queued, so B's put lands after A's deletes and the machine half comes
// back without its link. Nothing ever reads it again (every join goes link →
// extraction), but it's not harmless: it skews both facet-count readers (queries.ts —
// its outcome token has no link-total entry to cancel, so `pending` UNDER-counts,
// the one error direction the extract-all wake can't tolerate) and it leaks storage —
// the blob itself plus the `files/` content it references (image/screenshot/page copy,
// easily hundreds of KB) persist in R2 against the user's quota and in every device's
// local store, with no other reclamation path (destroy can't — the link is gone).
// So danglings are fixed by DELETION here, not by accounting in the count queries.
//
// WHO MAY CALL THIS — full-sync clients only, at the end of a completed sync cycle
// and inside its lock (the engine's SyncDeps.afterCycle). The test
// is "link absent LOCALLY", and it queues REMOTE deletes on that basis, so it's only
// sound where local absence proves server absence:
//   - no pull may be in flight and none left half-done: first sync done, no cycle
//     of this account running in any context, and the cycle just run a successful
//     one (a failed cycle's stored GETs stay while its cursor doesn't move, so an
//     extraction can sit there without the link the next cycle brings). The end of
//     a successful cycle, under its lock, gives exactly that — where Web Locks
//     exist; without them only this context's cycles are held off. Absence
//     mid-pull is meaningless: the fallback listing walks in path order,
//     `extractions/` sorts before `links/`, and a pull's GETs land in any order;
//   - the client must sync the WHOLE library: a selective-sync client (the browser
//     extension's documented future — docs/link-extraction.md) that skips some
//     `links/` would judge healthy extractions dangling and delete them for every
//     device. That's why bracemark-web hands it to its SyncProvider
//     (SyncProviderWithSweep) and no shared provider runs it by default;
//   - and even then, a link the pull SKIPPED is not absent from the server. A blob
//     that does not open under its path (sync/engine.ts openPulled) is passed over
//     and the cycle completes without it. The pull records those paths on the account's row
//     (SyncMetaRecord.unreadablePaths) before the cycle can complete, and the sweep
//     spares any extraction whose link is in that record: one link blob that fails
//     on this device must not delete that link's extraction — and its image,
//     screenshot and page copy — on every device. The record outlives the session
//     on purpose: the cursor is past the skipped link, so a later session's cycle
//     completes without meeting it again, and an extraction pulled after the skip
//     would otherwise look dangling then.
// Even so, a successful cycle is not proof that the store holds every path the
// server does, and these KNOWN GAPS can still have a link absent here, present
// there, and its extraction swept for every device:
//   - a skip made by a build from before the record existed, or by a tab still
//     running one: nothing recorded it, and the cursor is already past it;
//   - an op log restored beneath this device's cursor and then written to: the next
//     commit is stamped above the stale cursor, so the cycle is routed incremental
//     instead of to the fallback and never lists the ops the restore lost. A
//     fallback that failed partway and is followed by such a cycle leaves its
//     half-done pull uncompleted the same way;
//   - a queued put whose local record went missing (a queue an older build wedged):
//     the push drops it as orphaned, and the path stays absent unless the cycle's
//     own window lists it (sync/engine.ts incrementalCycle).
// A link resurrected on the server concurrently (edit-vs-delete LWW) can also lose
// its extraction to a sweep that raced it — the machine half only: it re-queues as
// pending and re-extracts, no user data at stake.
//
// Cost: one keys-only index scan of `extractions/` plus one keyed existence probe of
// the co-keyed `links/` paths — no blobs are read unless a dangling is actually found
// (normally none). Per-dangling teardown mirrors destroy's: `files/` content first,
// entities after, so an interruption leaves the extraction still dangling (with its
// refs intact) for the next run to finish — idempotent, and the queued deletes are
// harmless tombstones upstream if two devices sweep the same garbage.

import Dexie from 'dexie';

import {
  extractionFileIds,
  EXTRACTIONS_PREFIX,
  idFromPath,
  LINKS_PREFIX,
  rekey,
} from '@stxapps/shared';

import { db } from './db';
import { deleteExtraction, deleteFile } from './mutations';
import { readExtraction } from './queries';
import { getSyncMeta } from './sync-store';

// Sweep every dangling extraction: delete it (and its `files/` content) locally and
// queue the server deletes. Returns how many extractions were swept, so the caller
// knows whether to kick a sync cycle to push the tombstones.
export async function sweepDanglingExtractions(username: string): Promise<number> {
  const exPaths = await db.items
    .where('[itemType+itemUpdatedAt]')
    .between(['extraction', Dexie.minKey], ['extraction', Dexie.maxKey], true, true)
    .primaryKeys();
  if (exPaths.length === 0) return 0;

  const linkPaths = exPaths.map((path) => rekey(path, EXTRACTIONS_PREFIX, LINKS_PREFIX));
  const existing = new Set(await db.items.where('path').anyOf(linkPaths).primaryKeys());
  // Links a pull skipped as unreadable: absent here, not proven absent there.
  const unreadable = new Set((await getSyncMeta(username))?.unreadablePaths);

  let swept = 0;
  for (let i = 0; i < exPaths.length; i++) {
    if (existing.has(linkPaths[i]) || unreadable.has(linkPaths[i])) continue;

    // Dangling. Decode this one extraction for its `files/` refs (the link's own
    // customImageId was the destroyer's job), then tear down content-before-entity.
    const linkId = idFromPath(exPaths[i], EXTRACTIONS_PREFIX);
    const extraction = await readExtraction(linkId);
    for (const fileId of extractionFileIds(extraction)) await deleteFile(username, fileId);
    await deleteExtraction(username, linkId);
    swept += 1;
  }
  return swept;
}
