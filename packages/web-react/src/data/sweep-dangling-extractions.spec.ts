// Specs for the dangling-extraction janitor. A dangling extraction is an
// `extractions/{id}.enc` whose `links/{id}.enc` is gone — the writer-split's one delete
// race. Nothing ever reads it again, so its damage is entirely in what it SKEWS and
// LEAKS: it has an outcome token with no link-total entry to cancel, so the `pending`
// tally under-counts (the one direction the extract-all wake can't tolerate), and the
// `files/` blobs it references keep costing R2 quota on every device with no other
// reclamation path.
//
// The two properties worth pinning are the two ways this could be catastrophically
// wrong rather than merely ineffective:
//
//   - it must delete ONLY extractions whose link is absent. Over-deleting here queues
//     REMOTE deletes on the basis of a local read, so a false positive destroys a healthy
//     extraction — and its downloaded image/screenshot/page copy — for every device.
//   - the teardown is CONTENT BEFORE ENTITY, so an interruption leaves the extraction
//     still dangling with its refs intact for the next run to finish. Reversed, an
//     interruption strands the blobs with nothing pointing at them: the exact leak this
//     module exists to reclaim, now unreachable by it.
//
// Written through the real write edge (mutations.ts) against fake-indexeddb, so the
// index scan under test is the real `[itemType+itemUpdatedAt]` scan and the queued deletes
// are the real pending ops.

import {
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  LINKS_PREFIX,
  MY_LIST_ID,
  newFacet,
  pathFromId,
  rekey,
} from '@stxapps/shared';

import { db } from './db';
import { writeExtraction, writeFile, writeLink } from './mutations';
import { listPendingOps } from './pending-store';
import { sweepDanglingExtractions } from './sweep-dangling-extractions';

// The teardown ORDER is the thing under test below, and the finished state can't show it
// — the queue is keyed on (account, path), so it comes back in path order however the
// deletes were interleaved. So the two delete calls are recorded as they happen, over the
// REAL mutations underneath: the store still ends up in the state the assertions read.
const teardown: string[] = [];
jest.mock('./mutations', () => {
  const actual = jest.requireActual('./mutations') as typeof import('./mutations');
  return {
    ...actual,
    deleteFile: (username: string, fileId: string) => {
      teardown.push(`file:${fileId}`);
      return actual.deleteFile(username, fileId);
    },
    deleteExtraction: (username: string, linkId: string) => {
      teardown.push(`extraction:${linkId}`);
      return actual.deleteExtraction(username, linkId);
    },
  };
});

const USER = 'alice';

function seedLink(id: string): Promise<void> {
  return writeLink(
    USER,
    {
      path: pathFromId(id, LINKS_PREFIX),
      url: `https://example.com/${id}`,
      listId: MY_LIST_ID,
      tagIds: [],
      createdAt: 0,
      updatedAt: 0,
    },
    {},
  );
}

// An extraction with a settled facet and, optionally, the heavy `files/` content it
// references — the media that makes a dangling extraction expensive rather than merely
// untidy.
async function seedExtraction(
  id: string,
  fileIds: { imageId?: string; screenshotId?: string; pageCopyId?: string } = {},
): Promise<void> {
  for (const fileId of Object.values(fileIds)) {
    await writeFile(USER, fileId, new Uint8Array([1, 2, 3]));
  }
  await writeExtraction(USER, id, {
    fields: fileIds,
    facet: 'titleImage',
    state: newFacet('done', 'server'),
  });
}

const exists = async (path: string): Promise<boolean> => (await db.items.get(path)) !== undefined;

beforeEach(async () => {
  teardown.length = 0;
  await Promise.all([db.items.clear(), db.pendingOps.clear()]);
});

describe('sweepDanglingExtractions', () => {
  it('finds nothing in a healthy library', async () => {
    await seedLink('l_1');
    await seedExtraction('l_1');

    expect(await sweepDanglingExtractions(USER)).toBe(0);
    expect(await exists(pathFromId('l_1', EXTRACTIONS_PREFIX))).toBe(true);
  });

  it('is a no-op on an empty store', async () => {
    expect(await sweepDanglingExtractions(USER)).toBe(0);
  });

  // THE FALSE-POSITIVE GUARD. The sweep queues REMOTE deletes off a LOCAL absence test,
  // so a live link's extraction being judged dangling destroys the machine half —
  // image, screenshot and page copy included — on every device the tombstone reaches.
  it('spares every extraction whose link is still present', async () => {
    for (const id of ['l_1', 'l_2', 'l_3']) {
      await seedLink(id);
      await seedExtraction(id, { imageId: `f_${id}` });
    }
    await db.pendingOps.clear(); // the seed's own puts — the sweep must add nothing.

    expect(await sweepDanglingExtractions(USER)).toBe(0);
    expect(await listPendingOps(USER)).toEqual([]);
  });

  it('deletes an extraction whose link is gone', async () => {
    await seedExtraction('l_orphan');

    expect(await sweepDanglingExtractions(USER)).toBe(1);
    expect(await exists(pathFromId('l_orphan', EXTRACTIONS_PREFIX))).toBe(false);
  });

  // The storage half of the problem: the extraction blob is small, the media it points at
  // is easily hundreds of KB, and destroy can't reclaim it (the link is already gone).
  it('reclaims the files/ content the dangling extraction referenced', async () => {
    await seedExtraction('l_orphan', {
      imageId: 'f_image',
      screenshotId: 'f_shot',
      pageCopyId: 'f_copy',
    });

    await sweepDanglingExtractions(USER);

    for (const fileId of ['f_image', 'f_shot', 'f_copy']) {
      expect(await exists(pathFromId(fileId, FILES_PREFIX))).toBe(false);
    }
  });

  // CONTENT BEFORE ENTITY, and every ref before it. Reversed, an interruption between
  // the two strands the blobs with nothing pointing at them — permanently, since the next
  // run has no dangling extraction left to find them by.
  it('tears down every referenced file before the extraction that references them', async () => {
    await seedExtraction('l_orphan', {
      imageId: 'f_image',
      screenshotId: 'f_shot',
      pageCopyId: 'f_copy',
    });
    await db.pendingOps.clear();

    await sweepDanglingExtractions(USER);

    expect(teardown).toEqual(['file:f_image', 'file:f_shot', 'file:f_copy', 'extraction:l_orphan']);
    // …and every one of them is queued for the server as a delete, not just dropped
    // locally: the blobs cost R2 quota on the account, not only space on this device.
    const ops = await listPendingOps(USER);
    expect(ops.every((op) => op.op === 'delete')).toBe(true);
    expect(ops).toHaveLength(4);
  });

  // Idempotent by construction: two devices can sweep the same garbage, and a second run
  // after a completed one has nothing left to find.
  it('is idempotent — a second sweep finds nothing', async () => {
    await seedExtraction('l_orphan', { imageId: 'f_image' });

    expect(await sweepDanglingExtractions(USER)).toBe(1);
    expect(await sweepDanglingExtractions(USER)).toBe(0);
  });

  // The count is the caller's signal to kick a sync and push the tombstones. Under-report
  // it and the deletes sit in the queue unpushed; the number has to be the real one.
  it('reports how many were swept, so the caller knows to push the tombstones', async () => {
    await seedLink('l_live');
    await seedExtraction('l_live');
    await seedExtraction('l_orphan_a');
    await seedExtraction('l_orphan_b');

    expect(await sweepDanglingExtractions(USER)).toBe(2);
    expect(await exists(pathFromId('l_live', EXTRACTIONS_PREFIX))).toBe(true);
  });

  // A trashed link is NOT deleted — Trash is a listId, not a deletion, and its
  // `links/{id}.enc` is still there. The co-key probe is on the path, so this holds
  // without the sweep knowing anything about lists; the case is pinned because a future
  // "skip trashed links" refinement anywhere upstream would silently make every trashed
  // link's extraction look dangling.
  it('does not treat a trashed link’s extraction as dangling', async () => {
    await writeLink(
      USER,
      {
        path: pathFromId('l_trashed', LINKS_PREFIX),
        url: 'https://example.com/t',
        listId: 'trash',
        tagIds: [],
        createdAt: 0,
        updatedAt: 0,
      },
      {},
    );
    await seedExtraction('l_trashed');

    expect(await sweepDanglingExtractions(USER)).toBe(0);
  });

  // The extraction path and its link path are the same id under two prefixes; the sweep
  // derives one from the other with `rekey`, so this is the co-keying it depends on.
  it('probes the link co-keyed to the extraction, not some other link', async () => {
    await seedLink('l_1');
    await seedExtraction('l_2');

    await sweepDanglingExtractions(USER);

    expect(
      await exists(rekey(pathFromId('l_2', EXTRACTIONS_PREFIX), EXTRACTIONS_PREFIX, LINKS_PREFIX)),
    ).toBe(false);
    expect(await exists(pathFromId('l_2', EXTRACTIONS_PREFIX))).toBe(false);
    expect(await exists(pathFromId('l_1', LINKS_PREFIX))).toBe(true);
  });
});
