import { type BrowserContext, type Locator, type Page, type Request } from '@playwright/test';

import { BLOB_PATH, INITIAL_SYNC_RETRY_DELAYS_MS, SYNC_RETRY_JITTER } from '@stxapps/shared';

import { profileDir } from '../paths';
import { importArchive, waitForSync } from '../seed/steps';
import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { countRequests, holdNextRequest } from './fixtures/hold';
import { launchApp } from './fixtures/launch';
import { writePagedLibrary } from './fixtures/library';
import {
  addLink,
  addLinkButton,
  chooseRowMenuItem,
  linkRow,
  openSidebarItem,
} from './fixtures/links';
import { expectRowAtTop, scrollerOf, scrollTop, scrollUntilRow } from './fixtures/scroll';
import { syncAndWait } from './fixtures/sync';

// Cross-profile sync as the mounted links page receives it. The promotion rules
// — first paint, the user's own query change, the local-write grace window, idle
// — are unit-tested on `useLinks`; what only a browser shows is the painted pane:
// a pull that lands while the reader is scrolled must leave every row where it
// was, and the refresh pill must be what brings the new row in
// (docs/client-queries.md, _the staged snapshot rule_).

// The refresh pill. Its name is its only label, and there is exactly one.
function refreshPill(page: Page): Locator {
  return page.getByRole('button', { name: 'New updates' });
}

// Where a rendered row is painted, in page pixels.
async function rowTop(page: Page, url: string): Promise<number> {
  const box = await linkRow(page, url).boundingBox();
  if (!box) throw new Error(`row ${url} has no box`);
  return box.y;
}

// The first of `urls` whose row is painted wholly inside the scroller's box.
async function firstPaintedRow(page: Page, scroller: Locator, urls: string[]): Promise<string> {
  const view = await scroller.boundingBox();
  if (!view) throw new Error('scroller has no box');
  for (const url of urls) {
    if ((await linkRow(page, url).count()) === 0) continue;
    const box = await linkRow(page, url).boundingBox();
    if (box && box.y >= view.y && box.y + box.height <= view.y + view.height) return url;
  }
  throw new Error('no fixture row is painted inside the scroller');
}

test.describe('sync', () => {
  test(
    'a pull that lands under a scrolled reader waits behind the refresh pill',
    { tag: ['@SYNC-REFRESH-PILL-WEB-001', '@full', '@online', '@scale'] },
    async ({ isolatedApp: reader }, testInfo) => {
      // Three Argon2id ceremonies (reader, its import's sync, the writer) and a
      // sixty-link import: past the 90s default once the other worker is busy.
      test.setTimeout(3 * 60 * 1000);
      // 60 links in My List: a page and a bit, so the reader can scroll well past
      // the first screen, and every row's place in the date sort is known.
      const { page } = reader;
      const library = await writePagedLibrary(testInfo.outputPath('paged.zip'), {
        count: 60,
        label: unique('pill').toLowerCase(),
      });
      await importArchive(page, library.archivePath);
      // The import's own push settles first, so the cycle under test below is a
      // pull of one link and not the tail of sixty uploads.
      await waitForSync(page);

      await page.goto('/links');
      await expect(linkRow(page, library.urls[0])).toBeVisible();
      const scroller = await scrollerOf(linkRow(page, library.urls[0]));

      // --- engaged: scrolled well past the top ----------------------------------------
      // The anchor is the first row painted wholly inside the viewport there; its
      // painted position is what must not move.
      await scroller.evaluate((el) => el.scrollTo({ top: 1200 }));
      await expect.poll(() => scrollTop(scroller)).toBe(1200);
      const anchor = await firstPaintedRow(page, scroller, library.urls);
      const offset = await scrollTop(scroller);
      const anchorTop = await rowTop(page, anchor);

      // --- a second profile writes and pushes ------------------------------------------
      const remote = unresolvableUrl(unique('written-elsewhere'));
      const writer = await launchApp(profileDir(`pill-writer-w${testInfo.workerIndex}`), {
        existing: reader.credentials,
      });
      try {
        await writer.page.goto('/links');
        await addLink(writer.page, remote);
        await syncAndWait(writer.page);
      } finally {
        await writer.close();
      }

      // --- the reader pulls it, and nothing moves --------------------------------------
      await syncAndWait(page);
      expect(await scrollTop(scroller)).toBe(offset);
      expect(await rowTop(page, anchor)).toBe(anchorTop);
      await expect(refreshPill(page)).toBeVisible();
      // Held, not merely off-screen: the virtualizer renders an overscan past the
      // viewport, and a promoted snapshot would have mounted the new row at
      // index 0 whether or not it was painted.
      await expect(linkRow(page, remote)).toHaveCount(0);

      // --- the pill promotes, and the new row is the top state -------------------------
      await refreshPill(page).click();
      await expect(refreshPill(page)).toHaveCount(0);
      await expectRowAtTop(page, scroller, remote);
      expect(await rowTop(page, remote)).toBeLessThan(await rowTop(page, library.urls[0]));
    },
  );
});

// Sync between CLIENTS OF ONE ACCOUNT THAT ARE BUSY AT THE SAME MOMENT — two
// devices, or two tabs. Everything above this line has one client write and
// another read afterwards, in turn. These are the cases where they overlap, and
// each one used to end with the two sides disagreeing in silence: the cycle
// complete, the queue drained, the indicator idle (docs/local-first-sync.md, _the
// cursor is a claim_ and _two tabs, one queue_).
//
// The engine's own specs cover the decisions, against a server model and two
// copies of the module. What only this layer has is the real things those stand in
// for: the Durable Object's commit clamp and keyset pull, R2's paged listing, two
// browser profiles with a store each, and two tabs with ONE store and a Web Lock
// between them.
//
// Each case holds exactly one request of one client (fixtures/hold.ts) — the
// "slow round trip" — and lets the other client do whatever it then does,
// unaided. No clock is mocked and no response is rewritten, with one exception
// that is named where it happens: the listing's page size.

// Set a link's own title through the edit dialog — the one user-authored field a
// second device can be asked to read back by eye.
async function editTitle(page: Page, url: string, title: string): Promise<void> {
  await chooseRowMenuItem(page, url, 'Edit');
  const dialog = page.getByRole('dialog', { name: 'Edit link' });
  await dialog.getByRole('textbox', { name: 'Title' }).fill(title);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

// The next commit this page gets an answer to. Armed BEFORE the action that leads
// to it, as every `waitForResponse` has to be.
function nextCommit(page: Page) {
  return page.waitForResponse(
    (response) => response.url().includes('/v1/ops/commit') && response.ok(),
    { timeout: 60_000 },
  );
}

// Save a link and wait for its push, returning the storage path it was committed
// under — read off the page's own commit request, which is the only place a
// link's random id is visible from outside the app.
async function saveAndPush(page: Page, url: string): Promise<string> {
  const committed = nextCommit(page);
  await addLink(page, url);
  const body = (await committed).request().postDataJSON() as { ops: { path: string }[] };
  const path = body.ops.find((op) => op.path.startsWith('links/'))?.path;
  if (!path) throw new Error('the save committed no link');
  return path;
}

// A first sync's R2 listing, taken `pageSize` keys at a time and STOPPED after
// its first page until the case lets it go on.
//
// The page size is the one thing rewritten on the wire. The app asks for 1000 and
// the api may answer with fewer, so a small page is a legal answer — it makes a
// five-link library page the way a five-thousand-link one does, and that paging
// is the subject: a listing is not a snapshot, so a link saved into the key range
// it has already passed is simply not in it.
function pagedListing(pageSize: number) {
  let onFirstPage!: (lastPath: string) => void;
  const firstPage = new Promise<string>((resolve) => (onFirstPage = resolve));
  let resume!: () => void;
  const resumed = new Promise<void>((resolve) => (resume = resolve));
  let pages = 0;
  return {
    // The last path the first page showed: everything sorting before it has been
    // passed, everything after it is still to come.
    firstPage,
    resume,
    async prepare(context: BrowserContext): Promise<void> {
      await context.route('**/v1/files/list**', async (route) => {
        if (pages > 0) await resumed;
        pages += 1;
        const url = new URL(route.request().url());
        url.searchParams.set('limit', String(pageSize));
        const response = await route.fetch({ url: url.toString() });
        const body = (await response.json()) as { files: { path: string }[] };
        if (pages === 1) onFirstPage(body.files.at(-1)?.path ?? '');
        await route.fulfill({ response, json: body });
      });
    },
  };
}

// A first sync whose downloads fail — all but one. The blob at `survivor` is let
// through, so the attempt stores exactly that record before it dies; every other
// download is refused at the connection until `heal()`. That is the dropped
// connection the case is about, and it is the second thing these cases change on
// the wire (the first is the listing's page size, above).
//
// `cut()` counts the downloads refused. The case asserts it is not zero, so a read
// this matcher does not recognise fails there, by name, rather than as a gate that
// never offers Try again.
function brokenDownloads(survivor: string) {
  let broken = true;
  let cut = 0;
  return {
    heal(): void {
      broken = false;
    },
    cut: (): number => cut,
    async prepare(context: BrowserContext): Promise<void> {
      await context.route('**/*', async (route) => {
        const read = blobReadOf(route.request());
        const spared = read === survivor || read?.endsWith(`/${survivor}`);
        if (broken && read !== undefined && !spared) {
          cut += 1;
          await route.abort('connectionreset');
        } else {
          await route.fallback();
        }
      });
    },
  };
}

// What a request reads a blob at — its path, or a url path ending in it — or
// undefined when it is anything else, an upload included. A read takes one of
// two shapes, by what `files/sign` answered:
//   - the api's blob route (BLOB_PATH, docs/api-contracts.md): ONE url for every
//     read, so the path is in the token — a POST whose text body is
//     `Blob v1.<payload>.<mac>` (web's read; a GET carries it as Authorization),
//     the payload base64url JSON whose `p` is the path and `m` the grant;
//   - a presigned R2 url, or the api's dev proxy: a GET of the key, which ends in
//     the path.
// Matching only the second shape is how this case once broke nothing at all: the
// first sync went through, and the gate never offered Try again.
function blobReadOf(request: Request): string | undefined {
  const { pathname } = new URL(request.url());
  if (pathname.endsWith(BLOB_PATH)) {
    const credential =
      request.method() === 'POST' ? request.postData() : request.headers()['authorization'];
    const payload = credential?.split(' ')[1]?.split('.')[1];
    if (!payload) return undefined;
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      p?: string;
      m?: string;
    };
    return grant.m === 'GET' ? grant.p : undefined;
  }
  if (request.method() !== 'GET' || !pathname.endsWith('.enc')) return undefined;
  return pathname;
}

// Whether this profile's local store holds a record at `path` — read straight off
// the store, by the names of its schema (`bracemark-data`, `items`; the same
// addressing fixtures/store-hold.ts uses). The first-sync gate has nothing on
// screen to ask: it is blocking precisely because the store is not ready to show.
function storedLocally(page: Page, path: string): Promise<boolean> {
  return page.evaluate(
    (key) =>
      new Promise<boolean>((resolve, reject) => {
        const open = indexedDB.open('bracemark-data');
        open.onerror = () => reject(open.error ?? new Error('indexedDB.open failed'));
        open.onsuccess = () => {
          const db = open.result;
          const read = db.transaction('items', 'readonly').objectStore('items').getKey(key);
          read.onerror = () => reject(read.error ?? new Error('items read failed'));
          read.onsuccess = () => {
            db.close();
            resolve(read.result !== undefined);
          };
        };
      }),
    path,
  );
}

// Whether a sync cycle of this page's is QUEUED behind another tab's — asked of the
// origin's own lock queue, which is where a waiting cycle is, rather than inferred
// from a pause long enough for a free one to have finished. `bracemark-sync-cycle:`
// is the engine's lock name (packages/web-react/src/sync/engine.ts), the same kind
// of addressing as a store's name. Resolves false, rather than throwing, when no
// cycle is queued within the budget: that is the answer on an engine that takes no
// lock, and the case still has a held upload to release before it may fail.
async function syncQueuedBehindAnotherTab(page: Page, budgetMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const pending = await page.evaluate(async () =>
      ((await navigator.locks.query()).pending ?? []).map((lock) => lock.name ?? ''),
    );
    if (pending.some((name) => name.startsWith('bracemark-sync-cycle:'))) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(100);
  }
}

// Delete a link for good, the way a user does: to Trash, then out of it.
async function destroyLink(page: Page, url: string): Promise<void> {
  await chooseRowMenuItem(page, url, 'Remove');
  await openSidebarItem(page, 'Trash');
  await chooseRowMenuItem(page, url, 'Delete permanently');
  const confirm = page.getByRole('alertdialog', { name: 'Delete permanently?' });
  await confirm.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(linkRow(page, url)).toHaveCount(0);
  await openSidebarItem(page, 'My List');
}

test.describe('sync between clients in use at once', () => {
  test(
    'a link another device committed while this one was pushing still arrives',
    { tag: ['@SYNC-CURSOR-001', '@full', '@online'] },
    async ({ isolatedApp: first }, testInfo) => {
      // Two Argon2id ceremonies.
      test.setTimeout(3 * 60 * 1000);
      const { page } = first;
      await page.goto('/links');
      // An ordinary account in an ordinary state: something committed, and both
      // devices in step with it. (A brand-new account's first push takes the
      // listing route, which is the next case's.)
      await addLink(page, unresolvableUrl(unique('cursor-base')));
      await syncAndWait(page);

      const second = await launchApp(profileDir(`cursor-second-w${testInfo.workerIndex}`), {
        existing: first.credentials,
      });
      try {
        await second.page.goto('/links');
        await syncAndWait(second.page);

        // This device saves a link, and its commit is the slow round trip: by the
        // time it is held, the cycle has already listed the op log.
        const commit = await holdNextRequest(page, '**/v1/ops/commit');
        const savedHere = unresolvableUrl(unique('cursor-here'));
        await addLink(page, savedHere);
        await commit.reached;

        // Meanwhile the other device saves one, and pushes it.
        const savedThere = unresolvableUrl(unique('cursor-there'));
        await addLink(second.page, savedThere);
        await syncAndWait(second.page);

        // This device's commit lands AFTER it. The api stamps a commit above
        // everything already in the log — above the other device's link too — and
        // the cycle used to adopt that stamp as its cursor: past an op it had never
        // listed, where no later pull would return it.
        await commit.release();
        await syncAndWait(page);

        await page.reload();
        await expect(linkRow(page, savedHere)).toHaveCount(1);
        await expect(linkRow(page, savedThere)).toHaveCount(1);

        // The control: the other direction was never at risk — that device's
        // cursor stopped on its own link, below this one's.
        await syncAndWait(second.page);
        await second.page.reload();
        await expect(linkRow(second.page, savedHere)).toHaveCount(1);
      } finally {
        await second.close();
      }
    },
  );

  test(
    'a device signing in while another saves receives a link that landed behind its listing',
    { tag: ['@SYNC-LISTING-001', '@full', '@online'] },
    async ({ isolatedApp: writer }, testInfo) => {
      // Two Argon2id ceremonies, and a handful of saves that each wait for a push.
      test.setTimeout(4 * 60 * 1000);
      const { page } = writer;
      await page.goto('/links');
      // Six links, listed four to a page: the first page ends well inside the
      // key space, so a new random id is about as likely to sort before that
      // boundary as after it.
      for (let i = 0; i < 6; i++) await saveAndPush(page, unresolvableUrl(unique('listing-base')));

      const listing = pagedListing(4);
      const reader = await launchApp(profileDir(`listing-reader-w${testInfo.workerIndex}`), {
        existing: writer.credentials,
        prepare: listing.prepare,
      });
      try {
        // The new device has signed in and its first sync has read one page.
        const boundary = await listing.firstPage;

        // The writer keeps saving until one link has landed BEHIND the listing —
        // sorting before everything it has shown — and a LATER one ahead of it,
        // where a page still to come will show it. That pair is the whole case:
        // the listing then carries the newer of the two and not the older, and a
        // cursor taken from the newest stamp a listing showed sits past a link the
        // device was never given.
        let behind: string | undefined;
        let ahead: string | undefined;
        for (let i = 0; i < 40 && !(behind && ahead); i++) {
          const url = unresolvableUrl(unique('listing-live'));
          const path = await saveAndPush(page, url);
          if (!behind) {
            if (path < boundary) behind = url;
          } else if (path > boundary) {
            ahead = url;
          }
        }
        if (!behind || !ahead) throw new Error('forty saves never straddled the listing');

        listing.resume();
        // The first sync finishes and the app comes up; then an ordinary sync.
        await expect(addLinkButton(reader.page)).toBeVisible({ timeout: 60_000 });
        await syncAndWait(reader.page);
        await reader.page.reload();

        // The control first: the listing did reach the link saved ahead of it.
        await expect(linkRow(reader.page, ahead)).toHaveCount(1);
        // `behind` is the OLDEST of the live saves, and finding `ahead` can take a
        // couple of dozen of them — enough to push it below the virtualizer's
        // window, where a row that is in the store is simply not in the DOM. So
        // walk down to it rather than read its absence as a lost link.
        if ((await linkRow(reader.page, behind).count()) === 0) {
          const scroller = await scrollerOf(linkRow(reader.page, ahead));
          await scrollUntilRow(reader.page, scroller, behind);
        }
        await expect(linkRow(reader.page, behind)).toHaveCount(1);
      } finally {
        listing.resume();
        await reader.close();
      }
    },
  );

  test(
    'a first sync cut short and tried again drops a link another device deleted in between',
    { tag: ['@SYNC-RETRY-001', '@full', '@online'] },
    async ({ isolatedApp: writer }, testInfo) => {
      // Two Argon2id ceremonies, and the gate's own retries sat out in full.
      test.setTimeout(4 * 60 * 1000);
      const { page } = writer;
      await page.goto('/links');
      const doomed = unresolvableUrl(unique('retry-doomed'));
      const kept = unresolvableUrl(unique('retry-kept'));
      const doomedPath = await saveAndPush(page, doomed);
      await saveAndPush(page, kept);

      // A new device signs in, and its first sync dies partway: one link's blob
      // arrives and is stored, the rest of the pull fails.
      const downloads = brokenDownloads(doomedPath);
      const reader = await launchApp(profileDir(`retry-reader-w${testInfo.workerIndex}`), {
        existing: writer.credentials,
        prepare: downloads.prepare,
      });
      try {
        // The instrument first: the first sync's downloads are being cut.
        await expect
          .poll(downloads.cut, {
            message: 'no blob read matched brokenDownloads — has the read changed shape?',
            timeout: 30_000,
          })
          .toBeGreaterThan(0);
        // The gate retries a dropped connection on its own first, behind its
        // "Retrying…" line, and offers Try again only once that schedule is spent
        // (@stxapps/shared runInitialSyncWithRetries). Every one of those attempts
        // meets the same broken downloads, so the button comes after the longest
        // the schedule can jitter to, plus four attempts' own in-place retries.
        await expect(reader.page.getByRole('status').filter({ hasText: 'Retrying…' })).toBeVisible({
          timeout: 60_000,
        });
        const schedule = INITIAL_SYNC_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
        const tryAgain = reader.page.getByRole('button', { name: 'Try again' });
        await expect(tryAgain).toBeVisible({
          timeout: schedule * (1 + SYNC_RETRY_JITTER) + 60_000,
        });
        // The premise, checked rather than assumed: the interrupted attempt left
        // that link in the store. Without it the case below would pass on any
        // engine, having tested a retry over an empty store.
        await expect.poll(() => storedLocally(reader.page, doomedPath)).toBe(true);

        // Before anyone tries again, the other device deletes that link for good
        // — and then saves another, so the delete is not the newest thing the op
        // log holds.
        await destroyLink(page, doomed);
        await syncAndWait(page);
        const savedSince = unresolvableUrl(unique('retry-since'));
        await addLink(page, savedSince);
        await syncAndWait(page);

        // The connection is back, and the gate's own button retries the pull.
        // That pull lists a namespace without the link, and ends on a cursor above
        // the op that deleted it: nothing later says it is gone, so the retry has
        // to notice for itself — or the link stays on this one device for good.
        downloads.heal();
        await tryAgain.click();
        await expect(addLinkButton(reader.page)).toBeVisible({ timeout: 60_000 });
        await syncAndWait(reader.page);
        await reader.page.reload();

        // The controls first: the retry did the rest of its job.
        await expect(linkRow(reader.page, kept)).toHaveCount(1);
        await expect(linkRow(reader.page, savedSince)).toHaveCount(1);
        await expect(linkRow(reader.page, doomed)).toHaveCount(0);
        expect(await storedLocally(reader.page, doomedPath)).toBe(false);
      } finally {
        downloads.heal();
        await reader.close();
      }
    },
  );

  test(
    'a second tab’s sync waits for the first, and another device reads the later of two edits',
    { tag: ['@SYNC-TABS-001', '@full', '@online'] },
    async ({ isolatedApp }, testInfo) => {
      // Two Argon2id ceremonies.
      test.setTimeout(3 * 60 * 1000);
      const { context, page: tabA, credentials } = isolatedApp;
      const url = unresolvableUrl(unique('tabs'));
      const earlier = unique('Earlier edit');
      const later = unique('Later edit');

      await tabA.goto('/links');
      await addLink(tabA, url);
      await syncAndWait(tabA);
      // A second tab of the same profile: one store, one pending queue, and its
      // own copy of the sync engine.
      const tabB = await context.newPage();
      await tabB.goto('/links');
      await expect(linkRow(tabB, url)).toHaveCount(1);
      await syncAndWait(tabB);

      // Tab A edits the link, and its upload is the slow round trip: the bytes of
      // this edit are read and encrypted, and the PUT is out. (Any PUT — the only
      // ones a page makes are blob uploads, wherever the stack serves them from.)
      const upload = await holdNextRequest(tabA, '**/*', (request) => request.method() === 'PUT');
      await editTitle(tabA, url, earlier);
      await upload.reached;

      // The link is edited again, in the other tab — which kicks that tab's own
      // cycle. Without anything between the two tabs it ran start to finish here:
      // pushed the later edit, committed, cleared the queue. With the lock it is
      // queued behind tab A's, and the origin says so.
      const commitsFromTabB = countRequests(tabB, '/v1/ops/commit');
      await editTitle(tabB, url, later);
      const queued = await syncQueuedBehindAnotherTab(tabB);
      const committedMeanwhile = commitsFromTabB();

      // Tab A's upload lands, its cycle finishes, and tab B's gets its turn. Polled
      // rather than awaited as a response: a tab that had NOT waited has already
      // committed, and this must fall through to the expectation that says so
      // instead of timing out on a commit that is never coming.
      await upload.release();
      await expect.poll(commitsFromTabB, { timeout: 60_000 }).toBeGreaterThan(0);
      await syncAndWait(tabB);
      await syncAndWait(tabA);

      // Tab B's cycle waited for tab A's…
      expect(queued).toBe(true);
      expect(committedMeanwhile).toBe(0);
      // …so this device still shows its later edit…
      await tabA.reload();
      await expect(linkRow(tabA, url)).toContainText(later);

      // …and so does the server, read the only honest way: by a device that has
      // nothing but what the server gives it. Before, tab A's older upload landed
      // on top of tab B's newer one, and this read the EARLIER edit — with nothing
      // queued here to ever put it right.
      const reader = await launchApp(profileDir(`tabs-reader-w${testInfo.workerIndex}`), {
        existing: credentials,
      });
      try {
        await reader.page.goto('/links');
        await syncAndWait(reader.page);
        await expect(linkRow(reader.page, url)).toContainText(later);
      } finally {
        await reader.close();
      }
    },
  );
});
