// Specs for the SERVER-tier extraction worker. The whole design of this module is one
// distinction, stated three times in its header and enforced nowhere else:
//
//   a TRANSPORT failure of the extract request THROWS; every PER-LINK outcome is
//   RECORDED as a facet write and never re-throws.
//
// Both directions are silently catastrophic. Record a transport failure as a per-link
// `failed` and every link in the batch burns a backoff step, sync fills with no-op
// writes, and — in extract-all — the cursor marches through the whole library writing
// failures for pages nobody ever asked about. Throw on a per-link outcome instead and the
// drain stops at the first bad URL, so one 404 in a page of 20 stalls the rest forever.
// Neither shows up as an error anywhere: both produce a plausible-looking store.
//
// The other properties pinned here are the ones with no other cover:
//   - the TWO-PASS shape (titles first, images after) — the reason the page fills with
//     real titles before any image is fetched, and the reason a title survives an image
//     failure;
//   - the `failed` vs `done` verdict for an image fetch, which decides whether the image
//     is retried or lost to a passing throttle;
//   - URL DE-DUPE, where one result has to settle EVERY link carrying that url — the
//     same article saved twice is one fetch and two facet writes, and a worker that
//     wrote only the first would leave the second pending forever, re-fetching on every
//     scan.
//
// Everything below the module is real: the writes go through the real mutations into
// fake-indexeddb, so the facets asserted on are the ones the pending query would read.
// `resizeImage` needs no stub — it falls back to the original bytes when there is no
// `createImageBitmap` (resize-image.ts), which is exactly the case under node.

import {
  ApiError,
  type ExtractClient,
  type ExtractResult,
  FILES_PREFIX,
  type LinkItem,
  LINKS_PREFIX,
  MAX_EXTRACT_URLS,
  MY_LIST_ID,
  pathFromId,
} from '@stxapps/shared';

import { db } from '../data/db';
import { readExtraction } from '../data/queries';
import { runServerTitleImageBatch } from './server-extraction';

const USER = 'alice';

function linkItem(id: string, url: string): LinkItem {
  return {
    path: pathFromId(id, LINKS_PREFIX),
    url,
    listId: MY_LIST_ID,
    tagIds: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

const ok = (url: string, extra: Partial<ExtractResult> = {}): ExtractResult => ({
  url,
  ok: true,
  ...extra,
});

const failed = (url: string, extra: Partial<ExtractResult> = {}): ExtractResult => ({
  url,
  ok: false,
  ...extra,
});

// The extractor as the worker sees it. Both metadata entry points are stubbed so the
// single-vs-batch routing is observable — that routing is a real cost decision (one round
// trip and no proxy for the human-waiting single save).
function client(overrides: Partial<Record<keyof ExtractClient, unknown>> = {}): ExtractClient {
  return {
    extract: jest.fn(async (url: string) => ok(url)),
    extractMany: jest.fn(async (urls: string[]) => urls.map((url) => ok(url))),
    fetchImage: jest.fn(async () => new Uint8Array([1, 2, 3, 4])),
    ...overrides,
  } as unknown as ExtractClient;
}

const facetOf = async (id: string) => (await readExtraction(id))?.facets.titleImage;

beforeEach(async () => {
  await Promise.all([db.items.clear(), db.pendingOps.clear()]);
});

describe('runServerTitleImageBatch', () => {
  it('does nothing, and asks nothing, for an empty batch', async () => {
    const extractor = client();

    expect(await runServerTitleImageBatch(USER, [], extractor)).toBe(0);
    expect(extractor.extractMany).not.toHaveBeenCalled();
    expect(extractor.extract).not.toHaveBeenCalled();
  });

  // A caller-contract violation, and a fail-fast one: the drains bound a page to this cap
  // because the endpoint does. Sending an oversized batch would earn a 400 that the
  // transport branch would then treat as a whole-batch outage.
  it('refuses a batch larger than the endpoint’s cap, before any request', async () => {
    const extractor = client();
    const links = Array.from({ length: MAX_EXTRACT_URLS + 1 }, (_, i) =>
      linkItem(`l_${i}`, `https://example.com/${i}`),
    );

    await expect(runServerTitleImageBatch(USER, links, extractor)).rejects.toThrow(
      /MAX_EXTRACT_URLS/,
    );
    expect(extractor.extractMany).not.toHaveBeenCalled();
  });

  // The human-waiting single save: one round trip, and the inline-image path is only
  // available on this route.
  it('takes the single-URL route for one link and the batch route for several', async () => {
    const single = client();
    await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], single);
    expect(single.extract).toHaveBeenCalledWith('https://example.com/a');
    expect(single.extractMany).not.toHaveBeenCalled();

    const batch = client();
    await runServerTitleImageBatch(
      USER,
      [linkItem('l_1', 'https://example.com/a'), linkItem('l_2', 'https://example.com/b')],
      batch,
    );
    expect(batch.extractMany).toHaveBeenCalledWith([
      'https://example.com/a',
      'https://example.com/b',
    ]);
    expect(batch.extract).not.toHaveBeenCalled();
  });

  it('writes the extracted title and settles the facet done', async () => {
    const extractor = client({
      extract: jest.fn(async (url: string) => ok(url, { title: 'A real title' })),
    });

    expect(
      await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], extractor),
    ).toBe(1);

    const extraction = await readExtraction('l_1');
    expect(extraction?.title).toBe('A real title');
    expect(extraction?.facets.titleImage?.status).toBe('done');
    // The lowest tier, so a later active-page sighting can UPGRADE it.
    expect(extraction?.facets.titleImage?.extractedBy).toBe('server');
  });

  // A page with no og: tags and no <title> is the NORMAL outcome, not a failure — the
  // facet map is the sole authority, never the presence of a title.
  it('settles done for a page that yielded nothing to show', async () => {
    const extractor = client({ extract: jest.fn(async (url: string) => ok(url)) });

    await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], extractor);

    expect((await facetOf('l_1'))?.status).toBe('done');
    expect((await readExtraction('l_1'))?.title).toBeUndefined();
  });

  // THE THROW SIDE. A transport failure tells us nothing about any link, so it propagates
  // and the drain retries on the next wake — with NOTHING written, so no link's backoff
  // was burned by an outage.
  it('propagates a transport failure and records no per-link outcome', async () => {
    const extractor = client({
      extractMany: jest.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    });
    const links = [
      linkItem('l_1', 'https://example.com/a'),
      linkItem('l_2', 'https://example.com/b'),
    ];

    await expect(runServerTitleImageBatch(USER, links, extractor)).rejects.toThrow(
      'Failed to fetch',
    );
    expect(await readExtraction('l_1')).toBeUndefined();
    expect(await readExtraction('l_2')).toBeUndefined();
  });

  // THE RECORD SIDE. Once the request itself succeeded, the drain always makes progress:
  // a per-link failure settles into a facet the pending query then skips via backoff, and
  // the batch's other links are unaffected.
  it('records a per-link failure instead of throwing, and finishes the batch', async () => {
    const extractor = client({
      extractMany: jest.fn(async () => [
        failed('https://example.com/a', { error: 'fetch_failed' }),
        ok('https://example.com/b', { title: 'Fine' }),
      ]),
    });

    const processed = await runServerTitleImageBatch(
      USER,
      [linkItem('l_1', 'https://example.com/a'), linkItem('l_2', 'https://example.com/b')],
      extractor,
    );

    expect(processed).toBe(2);
    expect((await facetOf('l_1'))?.status).toBe('failed');
    expect((await facetOf('l_2'))?.status).toBe('done');
  });

  // The verdict for a failure comes from the SHARED rules, so a 404 through the extractor
  // settles exactly as a 404 fetched on-device does — the facet is synced, so two tiers
  // disagreeing would make a link's fate depend on which device saw it first.
  it('settles a relayed 404 permanent, so no device ever retries it', async () => {
    const extractor = client({
      extract: jest.fn(async (url: string) => failed(url, { error: 'bad_status', status: 404 })),
    });

    await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], extractor);

    expect((await facetOf('l_1'))?.status).toBe('permanent');
  });

  it('settles a relayed 503 as retryable', async () => {
    const extractor = client({
      extract: jest.fn(async (url: string) => failed(url, { error: 'bad_status', status: 503 })),
    });

    await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], extractor);

    expect((await facetOf('l_1'))?.status).toBe('failed');
  });

  // A URL the server simply omitted from the results is NOT an outcome — writing any
  // facet for it would settle a link nothing was ever said about.
  it('leaves a link pending when the server omitted its URL', async () => {
    const extractor = client({
      extractMany: jest.fn(async () => [ok('https://example.com/a', { title: 'Only A' })]),
    });

    await runServerTitleImageBatch(
      USER,
      [linkItem('l_1', 'https://example.com/a'), linkItem('l_2', 'https://example.com/b')],
      extractor,
    );

    expect(await readExtraction('l_2')).toBeUndefined();
  });

  describe('duplicate URLs', () => {
    // One fetch for the same article saved twice — and, more importantly, one result has
    // to settle BOTH links. Writing only the first leaves the second pending forever,
    // re-picked by every scan and re-fetched on every drain.
    it('fetches a repeated URL once and settles every link carrying it', async () => {
      const extractor = client({
        extract: jest.fn(async (url: string) => ok(url, { title: 'Shared' })),
      });

      await runServerTitleImageBatch(
        USER,
        [linkItem('l_1', 'https://example.com/a'), linkItem('l_2', 'https://example.com/a')],
        extractor,
      );

      // One distinct URL ⇒ the single-URL route, called exactly once.
      expect(extractor.extract).toHaveBeenCalledTimes(1);
      expect((await readExtraction('l_1'))?.title).toBe('Shared');
      expect((await readExtraction('l_2'))?.title).toBe('Shared');
      expect((await facetOf('l_2'))?.status).toBe('done');
    });

    // The return value is the caller's auto-budget, and it counts LINKS processed, not
    // urls fetched — a page of duplicates still consumed a page of the drain's work.
    it('reports links processed, not urls fetched', async () => {
      const extractor = client();

      const processed = await runServerTitleImageBatch(
        USER,
        [linkItem('l_1', 'https://example.com/a'), linkItem('l_2', 'https://example.com/a')],
        extractor,
      );

      expect(processed).toBe(2);
    });
  });

  describe('the image pass', () => {
    // Inline bytes are the single-save optimization: they must NOT trigger the proxy's
    // second round trip.
    it('uses inline bytes without going back to the proxy', async () => {
      const extractor = client({
        extract: jest.fn(async (url: string) =>
          ok(url, { title: 'T', imageBase64: 'AAECAw==', imageUrl: 'https://cdn.example/i.jpg' }),
        ),
      });

      await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], extractor);

      expect(extractor.fetchImage).not.toHaveBeenCalled();
      const imageId = (await readExtraction('l_1'))?.imageId;
      expect(imageId).toBeDefined();
      // The DECODED base64, so this also pins that the inline bytes were decoded rather
      // than stored as their base64 string.
      expect((await db.items.get(pathFromId(imageId ?? '', FILES_PREFIX)))?.data).toEqual(
        new Uint8Array([0, 1, 2, 3]),
      );
    });

    it('falls back to the proxy when only a URL was discovered', async () => {
      const extractor = client({
        extract: jest.fn(async (url: string) => ok(url, { imageUrl: 'https://cdn.example/i.jpg' })),
      });

      await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], extractor);

      expect(extractor.fetchImage).toHaveBeenCalledWith('https://cdn.example/i.jpg');
      expect((await readExtraction('l_1'))?.imageId).toBeDefined();
      expect((await facetOf('l_1'))?.status).toBe('done');
    });

    it('settles done with no image when the page had none', async () => {
      const extractor = client({
        extract: jest.fn(async (url: string) => ok(url, { title: 'T' })),
      });

      await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], extractor);

      expect(extractor.fetchImage).not.toHaveBeenCalled();
      expect((await facetOf('l_1'))?.status).toBe('done');
      expect((await readExtraction('l_1'))?.imageId).toBeUndefined();
    });

    // A passing throttle must not cost the image permanently — `failed` is what puts it
    // back in the pending set once the backoff cools.
    it.each([429, 500, 503])(
      'leaves the facet retryable when the image proxy answers %i',
      async (status) => {
        const extractor = client({
          extract: jest.fn(async (url: string) =>
            ok(url, { title: 'T', imageUrl: 'https://cdn.example/i.jpg' }),
          ),
          fetchImage: jest.fn(() => Promise.reject(new ApiError(status, ''))),
        });

        await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], extractor);

        expect((await facetOf('l_1'))?.status).toBe('failed');
        // TITLES FIRST is what makes that acceptable: the page already shows the real
        // title while the image waits for a retry.
        expect((await readExtraction('l_1'))?.title).toBe('T');
      },
    );

    // A non-429 4xx on the image is the server answering on the merits — retrying buys
    // nothing, so the link settles with its title and no preview rather than churning.
    it.each([403, 404, 415])(
      'settles done with the title when the image is a %i',
      async (status) => {
        const extractor = client({
          extract: jest.fn(async (url: string) =>
            ok(url, { title: 'T', imageUrl: 'https://cdn.example/i.jpg' }),
          ),
          fetchImage: jest.fn(() => Promise.reject(new ApiError(status, ''))),
        });

        await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], extractor);

        expect((await facetOf('l_1'))?.status).toBe('done');
        expect((await readExtraction('l_1'))?.imageId).toBeUndefined();
        expect((await readExtraction('l_1'))?.title).toBe('T');
      },
    );

    // A network error is not an ApiError at all — it has no status, and it is transient
    // by nature.
    it('treats a network failure on the image as retryable', async () => {
      const extractor = client({
        extract: jest.fn(async (url: string) =>
          ok(url, { title: 'T', imageUrl: 'https://cdn.example/i.jpg' }),
        ),
        fetchImage: jest.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
      });

      await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], extractor);

      expect((await facetOf('l_1'))?.status).toBe('failed');
    });

    // The pool must never throw: a failure inside one item's write is still a per-link
    // outcome, and it must not take the other links' progress with it.
    it('keeps the batch going when one link’s image write throws', async () => {
      const extractor = client({
        extractMany: jest.fn(async () => [
          ok('https://example.com/a', { title: 'A', imageUrl: 'https://cdn.example/a.jpg' }),
          ok('https://example.com/b', { title: 'B' }),
        ]),
        fetchImage: jest.fn(async (url: string) => {
          if (url.endsWith('a.jpg')) throw new Error('resize blew up');
          return new Uint8Array([1]);
        }),
      });

      await expect(
        runServerTitleImageBatch(
          USER,
          [linkItem('l_1', 'https://example.com/a'), linkItem('l_2', 'https://example.com/b')],
          extractor,
        ),
      ).resolves.toBe(2);

      expect((await facetOf('l_1'))?.status).toBe('failed');
      expect((await facetOf('l_2'))?.status).toBe('done');
    });
  });

  // THE WRITER SPLIT (docs/link-extraction.md): this worker writes only `extractions/`
  // and `files/`, never `links/{id}.enc` — which is what makes a backfill unable to
  // clobber a concurrent user edit. Nothing else enforces it; the write edge would take
  // a link write from here perfectly happily.
  it('never writes the link’s own blob', async () => {
    const extractor = client({
      extract: jest.fn(async (url: string) =>
        ok(url, { title: 'T', imageUrl: 'https://cdn.example/i.jpg' }),
      ),
    });
    await db.pendingOps.clear();

    await runServerTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], extractor);

    const written = (await db.pendingOps.toArray()).map((op) => op.path);
    expect(written.some((path) => path.startsWith(LINKS_PREFIX))).toBe(false);
    expect(written.length).toBeGreaterThan(0);
  });
});
