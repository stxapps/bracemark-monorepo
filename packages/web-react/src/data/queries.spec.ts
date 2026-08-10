// Specs for the `titleImage` TALLIES — the two counts the extraction surfaces are
// driven by, and the one piece of this read layer whose failure mode is silent: they
// are pure arithmetic over index counts, so a wrong term produces a plausible number,
// not an error. The rest of queries.ts is index-shaped (range scans, the clause
// compiler) and is covered by the app's own reads.
//
// The pair under test is deliberately NOT redundant (see their headers):
//
//   - `readRawPendingTitleImageCount` — four index counts, Trash NOT folded out. A
//     strict OVER-count (livePending + trashedPending), which is what makes it sound
//     as the drain's wake signal: 0 always means "nothing to do".
//   - `readExtractionFacetCounts` — the DISPLAY tally, exact, with the O(trash)
//     link↔extraction join folded out of every bucket.
//
// So the sharpest case here is the one where the two legitimately DISAGREE (a pending
// link sitting in Trash), and the invariant worth pinning hardest is that the exact
// tally's three buckets still sum to the LIVE link total — the Settings section renders
// that sum as its total, so a correction applied to one term and not another shows up
// as a total that doesn't match the library.
//
// Seeded through the real mutations, so the projection under test is the real one:
// `itemFacetStatuses` is written by the same put as the bytes it describes
// (projection.ts), and these counts read that index rather than any blob.
//
// The expo sibling (expo-react/src/data/extraction-queries.spec.ts) asserts the SAME
// table of expectations against SQLite — the two implementations are independent (a JS
// bulkGet+decode join here, a LEFT JOIN on the token junction there), so agreeing on
// these cases is the point.

import { LINKS_PREFIX, MY_LIST_ID, newFacet, pathFromId, TRASH_ID } from '@stxapps/shared';

import { db } from './db';
import { writeExtraction, writeLink } from './mutations';
import { readExtractionFacetCounts, readRawPendingTitleImageCount } from './queries';

const USER = 'alice';

// A link in `listId`, written through the real write edge (createdAt 0 → stamped now).
function seedLink(id: string, listId: string = MY_LIST_ID): Promise<void> {
  return writeLink(
    USER,
    {
      path: pathFromId(id, LINKS_PREFIX),
      url: `https://example.com/${id}`,
      listId,
      tagIds: [],
      createdAt: 0,
      updatedAt: 0,
    },
    {},
  );
}

// Settle a link's `titleImage` facet. No display fields: a `done` facet with neither a
// title nor an imageId is the NORMAL outcome for a page carrying no og: tags, and it
// must still count as done — the facet map is the sole authority, never the presence of
// a title (docs/link-extraction.md — _the extraction entity_).
function seedFacet(id: string, status: 'done' | 'failed' | 'permanent'): Promise<void> {
  return writeExtraction(USER, id, {
    facet: 'titleImage',
    state: newFacet(status, 'extension:fg'),
  });
}

beforeEach(async () => {
  await db.items.clear();
  await db.pendingOps.clear();
});

describe('readExtractionFacetCounts', () => {
  it('counts a link with no extraction as pending', async () => {
    // Absence IS pending — the writer-split means a link nothing has extracted yet has
    // no `extractions/` file at all, so there is no token to count and the bucket is a
    // set difference.
    await seedLink('a');

    expect(await readExtractionFacetCounts()).toEqual({ done: 0, pending: 1, failed: 0 });
  });

  it('counts a settled facet with no title or image as done', async () => {
    await seedLink('a');
    await seedFacet('a', 'done');

    expect(await readExtractionFacetCounts()).toEqual({ done: 1, pending: 0, failed: 0 });
  });

  it('folds permanent into failed', async () => {
    // Both are "not extracted, won't auto-retry without help", so the section shows them
    // as one number.
    await seedLink('a');
    await seedFacet('a', 'done');
    await seedLink('b');
    await seedFacet('b', 'failed');
    await seedLink('c');
    await seedFacet('c', 'permanent');
    await seedLink('d');

    expect(await readExtractionFacetCounts()).toEqual({ done: 1, pending: 1, failed: 2 });
  });

  it('excludes trashed links from every bucket', async () => {
    // The correction, in all three directions at once: a trashed link must not raise
    // Pending (the drains skip Trash, so it would be a stat that never drops), and must
    // not raise Done/Failed either, or the buckets stop summing to the live library.
    await seedLink('live-pending');
    await seedLink('live-done');
    await seedFacet('live-done', 'done');
    await seedLink('trash-pending', TRASH_ID);
    await seedLink('trash-done', TRASH_ID);
    await seedFacet('trash-done', 'done');
    await seedLink('trash-permanent', TRASH_ID);
    await seedFacet('trash-permanent', 'permanent');

    const counts = await readExtractionFacetCounts();

    expect(counts).toEqual({ done: 1, pending: 1, failed: 0 });
    // The invariant the Settings section renders: the three buckets ARE the live library.
    expect(counts.done + counts.pending + counts.failed).toBe(2);
  });

  it('never reports negative pending when a dangling extraction inflates the settled terms', async () => {
    // A dangling `extractions/{id}.enc` — its link destroyed on another device, its
    // write-back landing after (docs/link-extraction.md — _the data model_). Its token
    // counts against no link, so the settled terms can exceed the link total until
    // sweepDanglingExtractions removes it. Pending must clamp, not go negative.
    await seedLink('a');
    await seedFacet('ghost', 'done'); // no links/ghost.enc was ever written

    expect((await readExtractionFacetCounts()).pending).toBe(0);
  });
});

describe('readRawPendingTitleImageCount', () => {
  it('over-counts by the pending links sitting in Trash', async () => {
    // The deliberate divergence from the exact tally above, on the same seed: raw is
    // livePending + trashedPending. Over-counting is the safe side for a wake signal —
    // the walk that follows skips Trash inline and cleanly finds nothing.
    await seedLink('live-pending');
    await seedLink('trash-pending', TRASH_ID);

    expect(await readRawPendingTitleImageCount()).toBe(2);
    expect((await readExtractionFacetCounts()).pending).toBe(1);
  });

  it('reads 0 once every link is settled', async () => {
    // The property the wake signal leans on: 0 means "safe to stay asleep".
    await seedLink('a');
    await seedFacet('a', 'done');
    await seedLink('b');
    await seedFacet('b', 'permanent');

    expect(await readRawPendingTitleImageCount()).toBe(0);
  });
});
