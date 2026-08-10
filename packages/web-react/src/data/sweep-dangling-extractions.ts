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
// WHO MAY CALL THIS — full-sync clients only, after a completed sync cycle. The test
// is "link absent LOCALLY", and it queues REMOTE deletes on that basis, so it's only
// sound where local absence proves server absence:
//   - the store must hold a complete snapshot: first sync done AND a cycle finished
//     this session (the initial fallback listing walks in path order, and
//     `extractions/` sorts before `links/`, so absence mid-pull is meaningless);
//   - the client must sync the WHOLE library: a selective-sync client (the browser
//     extension's documented future — docs/link-extraction.md) that skips some
//     `links/` would judge healthy extractions dangling and delete them for every
//     device. That's why bracemark-web mounts the trigger (DanglingExtractionSweep) and
//     no shared always-on provider does.
// A link resurrected on the server concurrently (edit-vs-delete LWW) can still lose
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

import { EXTRACTIONS_PREFIX, idFromPath, LINKS_PREFIX, rekey } from '@stxapps/shared';

import { db } from './db';
import { deleteExtraction, deleteFile } from './mutations';
import { readExtraction } from './queries';

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

  let swept = 0;
  for (let i = 0; i < exPaths.length; i++) {
    if (existing.has(linkPaths[i])) continue;

    // Dangling. Decode this one extraction for its `files/` refs (the link's own
    // customImageId was the destroyer's job), then tear down content-before-entity.
    const linkId = idFromPath(exPaths[i], EXTRACTIONS_PREFIX);
    const extraction = await readExtraction(linkId);
    const fileIds = [extraction?.imageId, extraction?.screenshotId, extraction?.pageCopyId].filter(
      (fileId): fileId is string => typeof fileId === 'string',
    );
    for (const fileId of fileIds) await deleteFile(username, fileId);
    await deleteExtraction(username, linkId);
    swept += 1;
  }
  return swept;
}
