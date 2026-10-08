// Specs for the ON-DEVICE extraction worker. web-react's server-extraction.spec.ts is
// canonical for the WRITE half — the two-pass ordering, the writer split, per-link outcomes
// recorded rather than thrown — and this file deliberately does not re-litigate it. What is
// pinned here is the FETCH half, which was rebuilt rather than ported, and the two rules
// that exist only on this platform:
//
// 1. OFFLINE vs PER-HOST. Web gets one batch request, so a wholesale transport failure is
//    a single observable event. Here every link is its own fetch, and a rejected fetch is
//    indistinguishable per-link from "this host is down" — so the BATCH decides: if some
//    other link in it got a response, the failures were about those hosts and are recorded;
//    if NOTHING got a response, NetInfo decides: offline → the error is rethrown with
//    nothing written; connected → every host in the batch is dead, and each is recorded.
//    Get that backwards in either direction and it is silent — a subway ride would settle
//    `failed` on every link it touched, burning a backoff step each, or a batch of dead
//    hosts would never settle and the drain would re-pick that same step forever (which
//    it did, until EXTRACT-NATIVE-ALL-001 caught it).
//
// 2. THE FAVICON CARVE-OUT AND ITS GATE. Capturing the page's declared `<link rel=icon>`
//    is licensed by "this costs no disclosure the page fetch didn't already pay" — true of
//    the page's own host, FALSE of the third-party CDN an icon href may name. So with the
//    un-gestured opt-in off, a cross-origin icon must not be fetched. Nothing on the device
//    would look different if that gate stopped working; the only evidence is a request to a
//    host the user never saved from. Two further rules ride with it: a failed capture must
//    never write `none` (that would poison the guess path for a week — favicon-store's
//    two-filler rule), and the row is keyed on the FINAL host, so a shortener's redirect
//    doesn't paint the destination's icon on every link saved through it.
//
// The store and its writes are REAL (node:sqlite + the in-memory filesystem), so the facets
// asserted on are the ones the pending query would read. `./image` is stubbed — it is a
// pair of native decoders with its own spec, and here it stands for "the image was usable".
import { sql } from 'drizzle-orm';

import { type LinkItem, LINKS_PREFIX, MY_LIST_ID, pathFromId } from '@stxapps/shared';

import { clearCacheFiles } from '../data/cache-files';
import { getDb } from '../data/db';
import { readFavicon } from '../data/favicon-store';
import { readExtraction } from '../data/queries';
import { seedNewAccount } from '../data/sync-store';
import { runDeviceTitleImageBatch } from './device-extraction';
import { USER_AGENT } from './user-agent';

// The Response constructor's own body type, so the byte fixtures below don't have to name a
// lib-specific alias (RN's is `BodyInit_`, the DOM's is `BodyInit`).
type ResponseBody = ConstructorParameters<typeof Response>[0];

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
// The OS connectivity verdict, consulted only when a whole batch went unanswered.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: () => Promise.resolve({ isConnected: mockConnected }) },
}));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
jest.mock('@stxapps/expo-crypto', () => ({ newId: () => `id-${(mockIds += 1)}` }));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({ newId: () => `id-${(mockIds += 1)}` }));

// The two native decoders. Standing in for "the bytes were a usable image": the resize is a
// pass-through, so the temp file the worker wrote is the one it stores.
jest.mock('./image', () => ({
  probeImageSize: () => {
    mockOnProbe?.();
    return Promise.resolve(mockProbeSize);
  },
  resizeImage: (source: { uri: string; width: number; height: number }) => Promise.resolve(source),
}));

let mockIds = 0;
let mockConnected: boolean | null = false;
let mockProbeSize: { width: number; height: number } | undefined = { width: 800, height: 600 };
// Runs at the probe — the one moment a spec can observe the image while it is in transit.
let mockOnProbe: (() => void) | undefined;

const { listFileUris, resetFileSystem } = require('../testing/memory-file-system') as {
  listFileUris: () => string[];
  resetFileSystem: () => void;
};

const USER = 'alice';
const TIER = 'expo:fg' as const;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

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

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
}

let fetchMock: jest.Mock;

// Route by URL so a page fetch, an image fetch and an icon fetch can each be answered
// (and asserted on) independently.
function routes(table: Record<string, () => Response | Promise<Response>>): void {
  fetchMock.mockImplementation((url: string) => {
    const handler = table[url];
    if (!handler) return Promise.reject(new TypeError('Network request failed'));
    return Promise.resolve(handler());
  });
}

const requestedUrls = (): string[] => fetchMock.mock.calls.map(([url]) => url as string);
const facetOf = async (id: string) => (await readExtraction(id))?.facets.titleImage;

beforeEach(async () => {
  mockIds = 0;
  mockProbeSize = { width: 800, height: 600 };
  mockOnProbe = undefined;
  resetFileSystem();
  const tables = getDb().all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const { name } of tables) getDb().run(sql.raw(`DELETE FROM "${name}"`));
  await seedNewAccount(USER);
  fetchMock = jest.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

describe('runDeviceTitleImageBatch', () => {
  it('does nothing, and fetches nothing, for an empty batch', async () => {
    expect(await runDeviceTitleImageBatch(USER, [], TIER, { optedIn: true })).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes the page’s title and settles the facet done', async () => {
    routes({ 'https://example.com/a': () => html('<title>A real title</title>') });

    expect(
      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      }),
    ).toBe(1);

    const extraction = await readExtraction('l_1');
    expect(extraction?.title).toBe('A real title');
    expect(extraction?.facets.titleImage?.status).toBe('done');
  });

  // The tier is what lets a later, better sighting UPGRADE this one — a background sweep
  // ranks below a foreground drain, and both below an active page.
  it('stamps the facet with the tier it was run at', async () => {
    routes({ 'https://example.com/a': () => html('<title>T</title>') });

    await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], 'expo:bg', {
      optedIn: true,
    });

    expect((await facetOf('l_1'))?.extractedBy).toBe('expo:bg');
  });

  // Honest and attributable, never a browser impersonation — a site that wants to refuse
  // this traffic should be able to.
  it('identifies itself honestly on the page fetch', async () => {
    routes({ 'https://example.com/a': () => html('<title>T</title>') });

    await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
      optedIn: true,
    });

    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('User-Agent')).toBe(USER_AGENT);
  });

  // NEVER the extractor: native HTTP has no CORS, so routing through the server would buy
  // nothing and would downgrade the tier, spend a rate-limited request, and disclose the
  // URL to a party that would otherwise never see it.
  it('fetches the page directly, never through an extractor origin', async () => {
    routes({ 'https://example.com/a': () => html('<title>T</title>') });

    await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
      optedIn: true,
    });

    expect(requestedUrls()).toEqual(['https://example.com/a']);
  });

  // The same article saved twice is one fetch — and, more importantly, one result has to
  // settle BOTH links, or the second is re-picked and re-fetched by every later scan.
  it('fetches a repeated URL once and settles every link carrying it', async () => {
    routes({ 'https://example.com/a': () => html('<title>Shared</title>') });

    await runDeviceTitleImageBatch(
      USER,
      [linkItem('l_1', 'https://example.com/a'), linkItem('l_2', 'https://example.com/a')],
      TIER,
      { optedIn: true },
    );

    expect(requestedUrls()).toEqual(['https://example.com/a']);
    expect((await readExtraction('l_1'))?.title).toBe('Shared');
    expect((await readExtraction('l_2'))?.title).toBe('Shared');
    expect((await facetOf('l_2'))?.status).toBe('done');
  });

  describe('per-link verdicts', () => {
    // The status rules are the SHARED ones, because the verdict SYNCS: a 404 settled
    // `permanent` here has to be a 404 settled `permanent` on web, or a link's fate depends
    // on which device saw it first.
    it.each([
      [404, 'permanent'],
      [410, 'permanent'],
      [401, 'permanent'],
      [503, 'failed'],
      [429, 'failed'],
      [408, 'failed'],
    ] as const)('settles a %i as %s', async (status, verdict) => {
      routes({ 'https://example.com/a': () => new Response('', { status }) });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      expect((await facetOf('l_1'))?.status).toBe(verdict);
    });

    // Synthetic statuses are part of that shared vocabulary: a non-http(s) URL reports the
    // status the server WOULD have, so it lands on the same rules rather than a parallel
    // one — and settles permanent, because there is nothing to fetch, ever.
    it.each(['mailto:someone@example.com', 'not a url at all'])(
      'settles %s permanent without a fetch',
      async (url) => {
        routes({});

        await runDeviceTitleImageBatch(USER, [linkItem('l_1', url)], TIER, { optedIn: true });

        expect((await facetOf('l_1'))?.status).toBe('permanent');
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    // A PDF or an image URL is never going to become a page with an og:title, so retrying
    // it forever costs a request per link per backoff for an answer that cannot change.
    it('settles a non-HTML content-type permanent', async () => {
      routes({
        'https://example.com/a.pdf': () =>
          new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } }),
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a.pdf')], TIER, {
        optedIn: true,
      });

      expect((await facetOf('l_1'))?.status).toBe('permanent');
    });

    // An empty body is reported as a synthetic 204 — permanent for the same reason.
    it('settles an empty page permanent', async () => {
      routes({
        'https://example.com/a': () =>
          new Response('', { status: 200, headers: { 'content-type': 'text/html' } }),
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      expect((await facetOf('l_1'))?.status).toBe('permanent');
    });

    // A page with no title at all is a NORMAL outcome, not a failure — there is nothing to
    // come back for, and `host(url)` is the render fallback.
    it('settles a titleless page done rather than failed', async () => {
      routes({ 'https://example.com/a': () => html('<html><body>hi</body></html>') });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      expect((await facetOf('l_1'))?.status).toBe('done');
      expect((await readExtraction('l_1'))?.title).toBeUndefined();
    });
  });

  describe('offline versus a dead host', () => {
    // NOTHING answered: the device is offline, so nothing is recorded — no link's backoff
    // is burned by a subway ride — and the rethrown TypeError is what
    // `isRetryableTransportError` reads to back the drain off.
    it('throws and records nothing when no link reached a server while offline', async () => {
      mockConnected = false;
      routes({});

      await expect(
        runDeviceTitleImageBatch(
          USER,
          [linkItem('l_1', 'https://a.example/x'), linkItem('l_2', 'https://b.example/y')],
          TIER,
          { optedIn: true },
        ),
      ).rejects.toThrow(TypeError);

      expect(await readExtraction('l_1')).toBeUndefined();
      expect(await readExtraction('l_2')).toBeUndefined();
    });

    // NOTHING answered but the OS says the device is connected: every host in the batch is
    // dead. Recording them is what moves the drain's cursor on — thrown, the same step
    // would be re-picked forever.
    it('records every link as failed when none answered but the device is connected', async () => {
      mockConnected = true;
      routes({});

      await expect(
        runDeviceTitleImageBatch(
          USER,
          [linkItem('l_1', 'https://a.example/x'), linkItem('l_2', 'https://b.example/y')],
          TIER,
          { optedIn: true },
        ),
      ).resolves.toBe(2);

      expect((await facetOf('l_1'))?.status).toBe('failed');
      expect((await facetOf('l_2'))?.status).toBe('failed');
      mockConnected = false;
    });

    // SOMETHING answered, so the connection is fine and the failures really were about
    // those hosts — recorded, so the drain makes progress instead of re-picking them on
    // every scan forever.
    it('records the unreachable links as failed once any link got a response', async () => {
      routes({ 'https://b.example/y': () => html('<title>B</title>') });

      await expect(
        runDeviceTitleImageBatch(
          USER,
          [linkItem('l_1', 'https://a.example/x'), linkItem('l_2', 'https://b.example/y')],
          TIER,
          { optedIn: true },
        ),
      ).resolves.toBe(2);

      expect((await facetOf('l_1'))?.status).toBe('failed');
      expect((await facetOf('l_2'))?.status).toBe('done');
    });

    // An HTTP RESPONSE counts as reaching a server, even a failing one — a batch of 404s is
    // not an offline device, and treating it as one would stall the drain on links that
    // will never resolve.
    it('treats a status response as having reached a server', async () => {
      routes({
        'https://a.example/x': () => new Response('', { status: 404 }),
      });

      await expect(
        runDeviceTitleImageBatch(
          USER,
          [linkItem('l_1', 'https://a.example/x'), linkItem('l_2', 'https://b.example/y')],
          TIER,
          { optedIn: true },
        ),
      ).resolves.toBe(2);

      expect((await facetOf('l_1'))?.status).toBe('permanent');
      expect((await facetOf('l_2'))?.status).toBe('failed');
    });
  });

  describe('the image pass', () => {
    it('stores the discovered preview and settles done', async () => {
      routes({
        'https://example.com/a': () =>
          html('<title>T</title><meta property="og:image" content="https://cdn.example/i.png">'),
        'https://cdn.example/i.png': () =>
          new Response(PNG as unknown as ResponseBody, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      expect((await readExtraction('l_1'))?.imageId).toBeDefined();
      expect((await facetOf('l_1'))?.status).toBe('done');
    });

    // TITLES FIRST is what makes a retryable image failure acceptable: the list already
    // shows the real title while the preview waits for the next drain.
    it.each([429, 500, 503])(
      'leaves the facet retryable — with the title intact — when the image is a %i',
      async (status) => {
        routes({
          'https://example.com/a': () =>
            html('<title>T</title><meta property="og:image" content="https://cdn.example/i.png">'),
          'https://cdn.example/i.png': () => new Response('', { status }),
        });

        await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
          optedIn: true,
        });

        expect((await facetOf('l_1'))?.status).toBe('failed');
        expect((await readExtraction('l_1'))?.title).toBe('T');
      },
    );

    // A plain 4xx means the image is simply not available to us — retrying buys nothing, so
    // the link settles with its title and no preview.
    it.each([403, 404])('settles done with the title when the image is a %i', async (status) => {
      routes({
        'https://example.com/a': () =>
          html('<title>T</title><meta property="og:image" content="https://cdn.example/i.png">'),
        'https://cdn.example/i.png': () => new Response('', { status }),
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      expect((await facetOf('l_1'))?.status).toBe('done');
      expect((await readExtraction('l_1'))?.imageId).toBeUndefined();
    });

    // THE SNIFF. An og:image pointing at an HTML error page answers 200 with a perfectly
    // good content-type; storing it gives the UI a file it cannot render, and the facet
    // would say `done` with a broken preview.
    it('refuses bytes that are not a raster image', async () => {
      routes({
        'https://example.com/a': () =>
          html('<title>T</title><meta property="og:image" content="https://cdn.example/i.png">'),
        'https://cdn.example/i.png': () =>
          new Response('<html>404</html>', {
            status: 200,
            headers: { 'content-type': 'image/png' },
          }),
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      expect((await readExtraction('l_1'))?.imageId).toBeUndefined();
      expect((await facetOf('l_1'))?.status).toBe('done');
    });

    // A decoder that refuses the bytes is the same verdict from the other side — the probe
    // is required, not incidental (image.ts), and its `undefined` must not become a stored
    // file of unknown size.
    it('refuses an image the native decoder cannot read', async () => {
      mockProbeSize = undefined;
      routes({
        'https://example.com/a': () =>
          html('<title>T</title><meta property="og:image" content="https://cdn.example/i.png">'),
        'https://cdn.example/i.png': () =>
          new Response(PNG as unknown as ResponseBody, { status: 200 }),
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      expect((await readExtraction('l_1'))?.imageId).toBeUndefined();
      expect((await facetOf('l_1'))?.status).toBe('done');
    });

    // A KILL MID-EXTRACTION. The worker deletes its in-transit image in a `finally`, which a
    // killed process never runs — and the bytes are plaintext, a saved link's preview. Loose
    // in the cache dir that file had a name nobody knew and outlived the sign-out; nothing
    // looked different. So the sweep is run at the probe, standing in for the wipe that
    // follows the kill, and has to leave nothing.
    it('keeps the in-transit image where the sign-out sweep reaches it', async () => {
      let inTransit: string[] = [];
      let afterSweep: string[] | undefined;
      mockOnProbe = () => {
        inTransit = listFileUris();
        clearCacheFiles();
        afterSweep = listFileUris();
      };
      // The run itself ends on the refusal: its file is gone from under it.
      mockProbeSize = undefined;
      routes({
        'https://example.com/a': () =>
          html('<title>T</title><meta property="og:image" content="https://cdn.example/i.png">'),
        'https://cdn.example/i.png': () =>
          new Response(PNG as unknown as ResponseBody, { status: 200 }),
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      // The control: there WAS a file at the probe, so the empty list below is the sweep's
      // doing rather than a probe that ran before anything was written.
      expect(inTransit).toHaveLength(1);
      expect(afterSweep).toEqual([]);
    });
  });

  describe('the declared-favicon carve-out', () => {
    const PAGE_WITH_OWN_ICON = () =>
      html('<title>T</title><link rel="icon" href="https://example.com/icon.png">');
    const PAGE_WITH_CDN_ICON = () =>
      html('<title>T</title><link rel="icon" href="https://cdn.example/icon.png">');
    const iconResponse = () =>
      new Response(PNG as unknown as ResponseBody, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });

    it('caches the icon the page declared on its own host', async () => {
      routes({
        'https://example.com/a': PAGE_WITH_OWN_ICON,
        'https://example.com/icon.png': iconResponse,
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: false,
      });

      expect((await readFavicon('example.com'))?.status).toBe('ok');
    });

    // THE GATE. Without the un-gestured opt-in we are here on a SAVE, which paid for this
    // page's host and nothing else — a third-party CDN is a disclosure the gesture never
    // implied, and nothing on the device would show that it happened.
    it('does not fetch a cross-origin icon when the un-gestured opt-in is off', async () => {
      routes({
        'https://example.com/a': PAGE_WITH_CDN_ICON,
        'https://cdn.example/icon.png': iconResponse,
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: false,
      });

      expect(requestedUrls()).not.toContain('https://cdn.example/icon.png');
      expect(await readFavicon('example.com')).toBeUndefined();
    });

    it('does fetch a cross-origin icon once the un-gestured opt-in is on', async () => {
      routes({
        'https://example.com/a': PAGE_WITH_CDN_ICON,
        'https://cdn.example/icon.png': iconResponse,
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      expect((await readFavicon('example.com'))?.status).toBe('ok');
    });

    // NEVER `none`: "this page's declared icon didn't load" is not "this host has no icon",
    // and writing the miss would block the `/favicon.ico` guess — which might still
    // succeed — for a full FAVICON_RETRY_MS.
    it('records nothing when the declared icon fails to load', async () => {
      routes({
        'https://example.com/a': PAGE_WITH_OWN_ICON,
        'https://example.com/icon.png': () => new Response('', { status: 500 }),
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      expect(await readFavicon('example.com')).toBeUndefined();
    });

    it('records nothing when the declared icon is not a renderable image', async () => {
      routes({
        'https://example.com/a': PAGE_WITH_OWN_ICON,
        'https://example.com/icon.png': () => new Response('<html>nope</html>', { status: 200 }),
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      expect(await readFavicon('example.com')).toBeUndefined();
    });

    // A capture failure is decoration on top of decoration — it can never change the link's
    // own verdict.
    it('never affects the link’s verdict', async () => {
      routes({
        'https://example.com/a': PAGE_WITH_OWN_ICON,
        'https://example.com/icon.png': () => {
          throw new TypeError('Network request failed');
        },
      });

      await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
        optedIn: true,
      });

      expect((await facetOf('l_1'))?.status).toBe('done');
    });
  });

  // THE WRITER SPLIT: this worker writes only `extractions/` and `files/`, never
  // `links/{id}.enc` — which is what makes a backfill unable to clobber a concurrent user
  // edit. The write edge would take a link write from here perfectly happily.
  it('never writes the link’s own blob', async () => {
    routes({
      'https://example.com/a': () =>
        html('<title>T</title><meta property="og:image" content="https://cdn.example/i.png">'),
      'https://cdn.example/i.png': () =>
        new Response(PNG as unknown as ResponseBody, { status: 200 }),
    });

    await runDeviceTitleImageBatch(USER, [linkItem('l_1', 'https://example.com/a')], TIER, {
      optedIn: true,
    });

    const queued = getDb().all<{ path: string }>(sql`SELECT path FROM pending_ops`);
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.some(({ path }) => path.startsWith(LINKS_PREFIX))).toBe(false);
  });
});
