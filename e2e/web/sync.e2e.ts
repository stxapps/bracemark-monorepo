import { type Locator, type Page } from '@playwright/test';

import { profileDir } from '../paths';
import { importArchive, waitForSync } from '../seed/steps';
import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { launchApp } from './fixtures/launch';
import { writePagedLibrary } from './fixtures/library';
import { addLink, linkRow } from './fixtures/links';
import { expectRowAtTop, scrollerOf, scrollTop } from './fixtures/scroll';
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
