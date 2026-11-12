// Specs for the `titleImage` TALLIES — the expo sibling of web-react's
// data/queries.spec.ts, asserting the SAME table of expectations. That parallel is the
// point: the two implementations are independent (web bulk-gets each trashed link's
// co-keyed extraction and decodes it in JS; here the same correlation is a LEFT JOIN on
// the `item_facet_statuses` junction, decoding nothing), so a divergence between them is
// a real bug — the Settings section shows one number on the phone and another in the
// browser for the same account.
//
// Why these two counts and not the rest of queries.ts: they're pure arithmetic over
// index counts, so a wrong term yields a plausible number rather than an error. The
// sharpest case is where the two counts legitimately DISAGREE (a pending link in Trash —
// raw over-counts on purpose, being the drain's wake signal), and the invariant worth
// pinning hardest is that the exact tally's three buckets sum to the LIVE link total.
//
// A separate file from queries.spec.ts on purpose: that one stubs `getDb` to THROW (it
// covers the namespace reads, where nothing may reach sqlite). These are SQL — the
// aggregate join IS the subject — so they run against a real in-memory database through
// the real drizzle expo driver, like item-store.spec.ts.

import { sql } from 'drizzle-orm';

import {
  type Extraction,
  EXTRACTIONS_PREFIX,
  type Link,
  LINKS_PREFIX,
  MY_LIST_ID,
  newFacet,
  pathFromId,
  TRASH_ID,
  utf8,
} from '@stxapps/shared';

import { getDb } from './db';
import { putItemsUnqueued } from './item-store';
import { toItemRecord } from './projection';
import {
  readExtractionFacetCounts,
  readLinksPendingTitleImageForLinkPaths,
  readLinksPendingTitleImagePage,
  readRawPendingTitleImageCount,
} from './queries';
import { seedNewAccount } from './sync-store';

// The one seam that would reach native sqlite — everything above it (getDb, the PRAGMA,
// the DDL, the schema objects, the junction writes) runs for real.
jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
// queries.ts → file-store → expo-file-system / @stxapps/expo-crypto (both native).
// Nothing on the tally path touches a file, so inert them.
jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///documents/' },
  Directory: class {},
  File: class {},
}));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => 'id' }));

const USER = 'alice';

// Store one entity the way the write edge does: the real projector derives the row's
// columns (and the `item_facet_statuses` tokens) from the blob's own bytes.
function put(path: string, entity: object): Promise<string[]> {
  return putItemsUnqueued(USER, [toItemRecord(path, 1000, utf8(JSON.stringify(entity)))]);
}

function seedLink(id: string, listId: string = MY_LIST_ID): Promise<string[]> {
  const link: Link = {
    url: `https://example.com/${id}`,
    listId,
    tagIds: [],
    createdAt: 1000,
    updatedAt: 1000,
  };
  return put(pathFromId(id, LINKS_PREFIX), link);
}

// Settle a link's `titleImage` facet. No display fields: a `done` facet with neither a
// title nor an imageId is the NORMAL outcome for a page carrying no og: tags, and it
// must still count as done — the facet map is the sole authority, never the presence of
// a title (docs/link-extraction.md — _the extraction entity_).
function seedFacet(
  id: string,
  status: 'done' | 'failed' | 'permanent',
  extra?: Record<string, unknown>,
): Promise<string[]> {
  const extraction: Extraction = {
    id,
    facets: { titleImage: newFacet(status, 'expo:fg', extra) },
    createdAt: 1000,
    updatedAt: 1000,
  };
  return put(pathFromId(id, EXTRACTIONS_PREFIX), extraction);
}

// `getDb()` memoizes its connection, so the whole file shares one database (jest gives
// each spec FILE a fresh module registry). Truncate rather than reopen, enumerating the
// tables from `sqlite_master` so a table added to the DDL is cleared automatically.
beforeEach(() => {
  const tables = getDb().all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const { name } of tables) getDb().run(sql.raw(`DELETE FROM "${name}"`));
  // A signed-in account owns the store: pulled writes are fenced on its
  // bookkeeping row (sync-store.ts, AccountFencedError).
  void seedNewAccount(USER);
});

describe('readExtractionFacetCounts', () => {
  it('counts a link with no extraction as pending', async () => {
    // Absence IS pending — a link nothing has extracted yet has no `extractions/` row at
    // all, so there is no token to join against and the bucket is a set difference.
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
    // Summing them put a number that moves (a transient failure is retried once past its
    // backoff) in the same stat as one that cannot, which is why the section renders
    // `Will retry` / `Won't retry`. Web's spec pins the same split.
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
    // live library. The trashed permanent link is also the one case the section's copy
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

  it('counts each trashed link once even when its extraction carries other facets', async () => {
    // The join is restricted to the three titleImage tokens for exactly this reason: an
    // unrestricted one would multiply the trashed link by its other facets' tokens
    // (`done:screenshot`, …) and inflate the trashed-link total. The per-status sums stay
    // right, so it shows up as pending: 0 where 1 is live. Web can't get this wrong (it
    // reads one status per link in JS), which is precisely why the SQL needs its own case.
    const extraction: Extraction = {
      id: 'trash-many',
      facets: {
        titleImage: newFacet('done', 'expo:fg'),
        screenshot: newFacet('done', 'expo:fg'),
        pageCopy: newFacet('permanent', 'expo:fg'),
      },
      createdAt: 1000,
      updatedAt: 1000,
    };
    await seedLink('live-pending');
    await seedLink('trash-many', TRASH_ID);
    await put(pathFromId('trash-many', EXTRACTIONS_PREFIX), extraction);

    expect(await readExtractionFacetCounts()).toEqual({
      done: 0,
      pending: 1,
      failedTransient: 0,
      failedPermanent: 0,
    });
  });

  it('never reports negative pending when a dangling extraction inflates the settled terms', async () => {
    // A dangling `extractions/{id}.enc` — its link destroyed on another device, its
    // write-back landing after (docs/link-extraction.md — _the data model_). Its token
    // counts against no link, so the settled terms can exceed the link total until the
    // dangling is swept. Pending must clamp, not go negative.
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

// A plain-HTTP link this device reached over neither https nor http, several times:
// still `failed` in the synced state (a client that can fetch it retries it), but this
// device won't — so it isn't picked, and it's counted as won't-retry here
// (docs/link-extraction.md, _plain-HTTP links on a phone_).
describe('a plain-HTTP link this device cannot fetch', () => {
  const INSECURE = { reason: 'insecure-http' };

  it('is never picked by this device, however long it has cooled', async () => {
    await seedLink('a');
    await seedFacet('a', 'failed', INSECURE);
    await seedLink('b');
    await seedFacet('b', 'failed');

    const later = Date.now() + 365 * 24 * 60 * 60 * 1000;
    const picked = await readLinksPendingTitleImageForLinkPaths(
      [pathFromId('a', LINKS_PREFIX), pathFromId('b', LINKS_PREFIX)],
      later,
    );

    // The untagged failure is the positive control: past its backoff, it IS picked.
    expect(picked.map((link) => link.url)).toEqual(['https://example.com/b']);
  });

  it('counts as won’t-retry, live and trashed alike, and the buckets still sum', async () => {
    await seedLink('a');
    await seedFacet('a', 'failed', INSECURE);
    await seedLink('b');
    await seedFacet('b', 'failed');
    await seedLink('t', TRASH_ID);
    await seedFacet('t', 'failed', INSECURE);

    const counts = await readExtractionFacetCounts();

    expect(counts).toEqual({ done: 0, pending: 0, failedTransient: 1, failedPermanent: 1 });
    expect(counts.done + counts.pending + counts.failedTransient + counts.failedPermanent).toBe(2);
  });
});

describe('the unreadable record in the pending reads', () => {
  // A link whose extraction this device could not open has no extraction row HERE, so the
  // SQL calls it pending by absence. Extracting it would overwrite the server's copy, so
  // both reads skip a link whose extraction path the caller passes as recorded.
  const idsOf = (links: { path: string }[]) =>
    links.map((link) => link.path.replace(/^links\/|\.enc$/g, '')).sort();

  it('lists a link with no extraction, and not once its extraction path is recorded', async () => {
    await seedLink('a');
    await seedLink('b');
    const paths = ['links/a.enc', 'links/b.enc'];
    const recorded = new Set(['extractions/a.enc']);

    expect(idsOf(await readLinksPendingTitleImageForLinkPaths(paths, Date.now()))).toEqual([
      'a',
      'b',
    ]);
    expect(
      idsOf(await readLinksPendingTitleImageForLinkPaths(paths, Date.now(), recorded)),
    ).toEqual(['b']);
  });

  it('walks past a recorded link in the whole-library page and still reaches the rest', async () => {
    await seedLink('a');
    await seedLink('b');
    const recorded = new Set(['extractions/a.enc']);

    const page = await readLinksPendingTitleImagePage(Date.now(), 10, undefined, recorded);

    expect(idsOf(page.links)).toEqual(['b']);
    expect(page.cursor).toBeNull();
  });
});
