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
//
// Below them, the one rule of the NAMESPACE reads that is silent in the same way:
// whose id a list or tag is read back under (_the id a list or tag is read under_).
import {
  buildTree,
  emptyQuery,
  flattenTree,
  type LinkQuery,
  LINKS_PREFIX,
  LISTS_PREFIX,
  MY_LIST_ID,
  newFacet,
  pathFromId,
  ranksBetween,
  SYSTEM_LIST_IDS,
  SYSTEM_LIST_NAMES,
  TAGS_PREFIX,
  TRASH_ID,
} from '@stxapps/shared';

import { db } from './db';
import { bulkWriteEntities, writeExtraction, writeLink } from './mutations';
import {
  readExtractionFacetCounts,
  readLinks,
  readLists,
  readRawPendingTitleImageCount,
  readTags,
} from './queries';
import { seedNewAccount } from './sync-store';

const USER = 'alice';

// A link in `listId`, written through the real write edge (createdAt 0 → stamped now).
function seedLink(id: string, listId: string = MY_LIST_ID, note?: string): Promise<void> {
  return writeLink(
    USER,
    {
      path: pathFromId(id, LINKS_PREFIX),
      url: `https://example.com/${id}`,
      listId,
      tagIds: [],
      note,
      createdAt: 0,
      updatedAt: 0,
    },
    {},
  );
}

// A query carrying only a `note` clause — the shape the search editor's "Note
// contains" box commits (bare words → `all`).
function noteQuery(words: string[]): LinkQuery {
  const query = emptyQuery();
  query.note.all = words;
  return query;
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
  await db.syncMeta.clear();
  await seedNewAccount(USER);
  await db.items.clear();
  await db.pendingOps.clear();
});

describe('readExtractionFacetCounts', () => {
  it('counts a link with no extraction as pending', async () => {
    // Absence IS pending — the writer-split means a link nothing has extracted yet has
    // no `extractions/` file at all, so there is no token to count and the bucket is a
    // set difference.
    await seedLink('a');

    expect(await readExtractionFacetCounts()).toEqual({
      done: 0,
      pending: 1,
      failedTransient: 0,
      failedPermanent: 0,
    });
  });

  it('counts a settled facet with no title or image as done', async () => {
    await seedLink('a');
    await seedFacet('a', 'done');

    expect(await readExtractionFacetCounts()).toEqual({
      done: 1,
      pending: 0,
      failedTransient: 0,
      failedPermanent: 0,
    });
  });

  it('counts transient and permanent failures as separate buckets', async () => {
    // The two used to be summed into one `failed`, which put a number that moves (a
    // transient failure is retried once past its backoff) in the same stat as one that
    // cannot (a permanent verdict is never eligible again, on any device). The section
    // renders them as `Will retry` / `Won't retry` precisely so the settled half stops
    // reading as a stuck queue — keep them apart.
    await seedLink('a');
    await seedFacet('a', 'done');
    await seedLink('b');
    await seedFacet('b', 'failed');
    await seedLink('c');
    await seedFacet('c', 'permanent');
    await seedLink('d');

    expect(await readExtractionFacetCounts()).toEqual({
      done: 1,
      pending: 1,
      failedTransient: 1,
      failedPermanent: 1,
    });
  });

  it('excludes trashed links from every bucket', async () => {
    // The correction, in all four directions at once: a trashed link must not raise
    // Pending (the drains skip Trash, so it would be a stat that never drops), and must
    // not raise Done/Will-retry/Won't-retry either, or the buckets stop summing to the
    // live library. The trashed permanent link is also the one case the pane's copy
    // leans on — trashing is what makes that stat come down.
    await seedLink('live-pending');
    await seedLink('live-done');
    await seedFacet('live-done', 'done');
    await seedLink('trash-pending', TRASH_ID);
    await seedLink('trash-done', TRASH_ID);
    await seedFacet('trash-done', 'done');
    await seedLink('trash-permanent', TRASH_ID);
    await seedFacet('trash-permanent', 'permanent');
    await seedLink('trash-failed', TRASH_ID);
    await seedFacet('trash-failed', 'failed');

    const counts = await readExtractionFacetCounts();

    expect(counts).toEqual({ done: 1, pending: 1, failedTransient: 0, failedPermanent: 0 });
    // The invariant the Settings section renders: the four buckets ARE the live library.
    expect(counts.done + counts.pending + counts.failedTransient + counts.failedPermanent).toBe(2);
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

// The `note` clause is the one text rung that reads the LINK blob and nothing else —
// no extraction join, and (unlike every other clause here) no index behind it. These
// pin the two things that would fail silently: that an absent note is an empty
// haystack rather than a match, and that a note clause disqualifies the exact-count
// fast path the way the url/title/text clauses do. A wrong answer to either is a
// plausible list of links, not an error.
describe('readLinks with a note clause', () => {
  it('keeps only the links whose note contains every word, matching case-insensitively', async () => {
    await seedLink('a', MY_LIST_ID, 'Read before the CRDT talk');
    await seedLink('b', MY_LIST_ID, 'crdt reading, later');
    await seedLink('c', MY_LIST_ID, 'nothing to do with it');
    await seedLink('d'); // no note at all

    const result = await readLinks(noteQuery(['crdt']), 20);

    expect(result.links.map((l) => l.path).sort()).toEqual([
      pathFromId('a', LINKS_PREFIX),
      pathFromId('b', LINKS_PREFIX),
    ]);
  });

  it('does not match a link with no note, even on a word the url carries', async () => {
    // The haystack is the note ALONE — a note clause must never fall back to the url,
    // or "Note contains" would quietly answer with url hits and the field would look
    // like it works while filtering nothing.
    await seedLink('example');

    expect((await readLinks(noteQuery(['example']), 20)).links).toEqual([]);
  });

  it('drops the exact total, because the count cannot come from an index', async () => {
    // `hasTextClause` gates the count: the note lives in the blob, so the survivors are
    // only known after decoding. An exact `total` here would be the pre-filter count —
    // a "247 links" header over a page of three.
    await seedLink('a', MY_LIST_ID, 'kept');
    await seedLink('b', MY_LIST_ID, 'dropped');

    expect((await readLinks(noteQuery(['kept']), 20)).total).toBeUndefined();
    // The same view with no note clause still counts off the index.
    expect((await readLinks(emptyQuery(), 20)).total).toBe(2);
  });
});

// A list's and a tag's identity is its PATH (shared sync/paths.ts, idFromPath);
// the `id` in its plaintext is a copy, and nothing between a backup or another
// device and this store makes the copy agree. Every reader downstream goes by the
// `id` these two hand back — the tree resolves parents against it, the system
// lists are recognised by it, the lock model covers it — so a read edge that
// passed the copy through let a stored record choose its own identity. Seeded
// through bulkWriteEntities, the edge a restore writes through: it stores what it
// is given.
describe('the id a list or tag is read under', () => {
  const [RANK_A, RANK_B] = ranksBetween(null, null, 2);
  const entity = (id: string, name: string, parentId: string | null, rank: string) => ({
    id,
    name,
    parentId,
    rank,
    createdAt: 1,
    updatedAt: 1,
  });
  const userLists = async () => (await readLists()).filter((list) => !SYSTEM_LIST_IDS.has(list.id));

  it('is the path id, whatever the plaintext says', async () => {
    await bulkWriteEntities(USER, [
      { path: pathFromId('a', LISTS_PREFIX), data: entity('claimed', 'A', null, RANK_A) },
      { path: pathFromId('t', TAGS_PREFIX), data: entity('claimed', 'T', null, RANK_A) },
    ]);

    expect((await userLists()).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'a', name: 'A' },
    ]);
    expect((await readTags()).map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 't', name: 'T' },
    ]);
  });

  // The case the rule exists for. Two records under one id were both a child of
  // its parent and a parent of its children, so the tree held each level once per
  // copy of the level above — more nodes than there were lists.
  it('keeps records that claim one id apart, so the tree holds each once', async () => {
    await bulkWriteEntities(USER, [
      { path: pathFromId('a', LISTS_PREFIX), data: entity('shared', 'A', null, RANK_A) },
      { path: pathFromId('b', LISTS_PREFIX), data: entity('shared', 'B', null, RANK_B) },
      { path: pathFromId('c', TAGS_PREFIX), data: entity('shared', 'C', null, RANK_A) },
      { path: pathFromId('d', TAGS_PREFIX), data: entity('shared', 'D', null, RANK_B) },
    ]);

    const lists = await userLists();
    const tags = await readTags();

    expect(lists.map((list) => list.id)).toEqual(['a', 'b']);
    expect(flattenTree(buildTree(lists)).map((node) => node.item.name)).toEqual(['A', 'B']);
    expect(tags.map((tag) => tag.id)).toEqual(['c', 'd']);
    expect(flattenTree(buildTree(tags)).map((node) => node.item.name)).toEqual(['C', 'D']);
  });

  // The system-list merge is by id, so it has to see the path's. A record stored
  // anywhere else that calls itself `trash` replaced Trash — its name, its place
  // in the tree — for every screen at once.
  it('does not take a record stored elsewhere for a system list', async () => {
    await bulkWriteEntities(USER, [
      { path: pathFromId('a', LISTS_PREFIX), data: entity(TRASH_ID, 'Not Trash', null, RANK_A) },
    ]);

    const lists = await readLists();

    expect(lists.find((list) => list.id === TRASH_ID)?.name).toBe(SYSTEM_LIST_NAMES[TRASH_ID]);
    expect(lists.find((list) => list.id === 'a')?.name).toBe('Not Trash');
    expect(lists.filter((list) => list.id === TRASH_ID)).toHaveLength(1);
  });

  it('reads the record at a system path as that list, whatever it calls itself', async () => {
    await bulkWriteEntities(USER, [
      { path: pathFromId(TRASH_ID, LISTS_PREFIX), data: entity('claimed', 'Bin', null, RANK_A) },
    ]);

    const lists = await readLists();

    expect(lists.find((list) => list.id === TRASH_ID)?.name).toBe('Bin');
    expect(lists.some((list) => list.id === 'claimed')).toBe(false);
  });
});
