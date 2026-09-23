import { type Locator, type Page } from '@playwright/test';

import { importArchive } from '../seed/steps';
import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { addLink, linkRow, openSidebarItem } from './fixtures/links';
import { grantPlusAndLoad } from './fixtures/plan';
import { writeScaleLibrary } from './fixtures/scale-library';
import { scrollerOf, scrollTop, scrollUntilRow } from './fixtures/scroll';
import { holdItemsStore } from './fixtures/store-hold';

// The links page at the two ends of its read: a library big enough that paging
// is the only way to its far rows, and the moment before the first read has
// answered at all. Both are claims about what a real browser paints — the read
// layer's own specs already prove what `readLinks` returns
// (docs/client-queries.md, _pagination_ and _the pinned overlay_).

async function dataIndex(row: Locator): Promise<number> {
  const value = await row.getAttribute('data-index');
  if (value === null) throw new Error('row has no data-index');
  return Number(value);
}

// The first-read skeleton: the one status region the pane renders before any
// row exists (layout-chrome.tsx). Its sentence is the announcement, so the
// wording is the contract here.
function skeleton(page: Page): Locator {
  return page.getByRole('status').filter({ hasText: 'Loading links…' });
}

// Every bone block the skeleton paints — a row in the list, a card in the grid
// — as boxes, for the claim that it is PAINTED inside the viewport rather than
// merely present.
async function boneBoxes(page: Page) {
  const blocks = skeleton(page).locator('[aria-hidden="true"] > div');
  const boxes = [];
  for (const block of await blocks.all()) {
    const box = await block.boundingBox();
    if (box) boxes.push(box);
  }
  return boxes;
}

test.describe('scale', () => {
  test(
    'a 1,000-link library pages past its first result set without repeating a pinned row',
    { tag: ['@SCALE-WEB-001', '@full', '@online', '@scale'] },
    async ({ isolatedApp }, testInfo) => {
      // Argon2id, the grant, a thousand-link import, and ~960 rows of scrolling.
      test.setTimeout(8 * 60 * 1000);
      const { page, credentials } = isolatedApp;
      // Free holds 200 links and refuses a larger backup whole.
      await grantPlusAndLoad(page, credentials.username);
      const library = await writeScaleLibrary(testInfo.outputPath('scale.zip'));
      await importArchive(page, library.archivePath);

      await page.goto('/links');
      await openSidebarItem(page, 'Show All');

      // --- the overlay: every pin once, at the top, in rank order ----------------------
      for (const [index, url] of library.pinned.entries()) {
        const row = linkRow(page, url);
        await expect(row).toHaveCount(1);
        expect(await dataIndex(row)).toBe(index);
        await expect(row.getByLabel('Pinned')).toBeVisible();
      }
      const first = linkRow(page, library.rest[0]);
      await expect(first).toHaveCount(1);
      expect(await dataIndex(first)).toBe(library.pinned.length);
      const scroller = await scrollerOf(first);

      // --- past the first page: each deep pin's neighbours close over its slot ----------
      // With the pin excluded from the rest, the links dated either side of it
      // are consecutive rows. A pin that paged in a second time would sit
      // between them and push the second one down an index.
      for (const pin of library.deepPins) {
        await scrollUntilRow(page, scroller, pin.after);
        const before = linkRow(page, pin.before);
        const after = linkRow(page, pin.after);
        await expect(before).toHaveCount(1);
        expect(await dataIndex(after)).toBe((await dataIndex(before)) + 1);
        // Mounted nowhere down here: the overlay's copy is pages above the
        // virtualizer's window, and there is no second copy.
        await expect(linkRow(page, pin.url)).toHaveCount(0);
        expect(await scrollTop(scroller)).toBeGreaterThan(0);
      }

      // --- the far end: the known last row, at exactly the index the fixture predicts ---
      // One extra row anywhere above it — a duplicated pin on any page — and this
      // index is off by one. Then nothing is left to page in.
      const last = library.rest[library.rest.length - 1];
      await scrollUntilRow(page, scroller, last);
      expect(await dataIndex(linkRow(page, last))).toBe(
        library.pinned.length + library.rest.length - 1,
      );
      await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
      await testInfo.attach('scale-web-far-end', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    },
  );

  test(
    'a held first read paints the list and card skeletons and announces that links are loading',
    { tag: ['@SKELETON-WEB-001', '@full', '@online', '@destructive', '@visual'] },
    async ({ isolatedApp }, testInfo) => {
      test.setTimeout(3 * 60 * 1000);
      const { context, page } = isolatedApp;
      const url = unresolvableUrl(unique('skeleton'));
      await page.goto('/links');
      await addLink(page, url);

      for (const variant of ['list', 'card'] as const) {
        if (variant === 'card') {
          // The DEVICE layout, because it lives outside the held store: with
          // the synced settings blob waiting behind the hold too, the synced
          // choice would read as the default (list) until the read answered.
          // The theme group below has a Device tab of its own.
          await page.goto('/settings/misc');
          const layout = page
            .locator('section')
            .filter({ has: page.getByRole('heading', { name: 'Link layout' }) });
          await layout.getByRole('tab', { name: 'Device' }).click();
          const card = layout.getByRole('radio', { name: 'Card' });
          await card.click();
          await expect(card).toHaveAttribute('data-state', 'checked');
        }

        const hold = await holdItemsStore(context);
        try {
          // A fresh document, so the links page mounts with no snapshot at all.
          await page.goto('/links');
          await expect(skeleton(page)).toBeVisible();
          await expect(skeleton(page)).toHaveAttribute('aria-live', 'polite');
          // Held: the pane has no row to show, however long this takes.
          await expect(linkRow(page, url)).toHaveCount(0);

          const viewport = page.viewportSize();
          if (!viewport) throw new Error('page has no viewport');
          const boxes = await boneBoxes(page);
          const painted = boxes.filter(
            (box) =>
              box.width > 0 &&
              box.height > 0 &&
              box.y >= 0 &&
              box.y + box.height <= viewport.height,
          );
          // A pane's worth, not a stray bar: several blocks fully in view.
          expect(painted.length).toBeGreaterThanOrEqual(3);
          if (variant === 'card') {
            // A grid, not a column: the first row holds more than one card.
            const top = Math.min(...painted.map((box) => box.y));
            const firstRow = painted.filter((box) => Math.abs(box.y - top) < 1);
            expect(firstRow.length).toBeGreaterThan(1);
          }
          await testInfo.attach(`skeleton-web-${variant}`, {
            body: await page.screenshot(),
            contentType: 'image/png',
          });
        } finally {
          await hold.release();
        }

        // Released, the same mounted page reads and the skeleton gives way.
        await expect(linkRow(page, url)).toBeVisible();
        await expect(skeleton(page)).toHaveCount(0);
      }
    },
  );
});
