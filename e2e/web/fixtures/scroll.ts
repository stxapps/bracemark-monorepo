import { expect, type Locator, type Page } from '@playwright/test';

import { unique } from './data';
import { linkRow } from './links';

// The links pane's scroller, for the cases whose subject is what happens past
// the first screen: paging, virtualization, the scroll reset.

// The nearest scrollable ancestor of a rendered row, marked so it can be found
// again. Found from a row rather than by class, since both layouts own their own
// scroller (docs/client-queries.md, _pagination_). The marker is lost if the
// scroller remounts, which then fails the next step loudly rather than letting a
// fresh element's scrollTop of 0 pass a reset check.
export async function scrollerOf(row: Locator): Promise<Locator> {
  const marker = unique('scroller');
  await row.evaluate((el, id) => {
    let node = el.parentElement;
    while (node) {
      const style = getComputedStyle(node);
      if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
        node.setAttribute('data-e2e-scroller', id);
        return;
      }
      node = node.parentElement;
    }
    throw new Error('no scrollable ancestor');
  }, marker);
  return row.page().locator(`[data-e2e-scroller="${marker}"]`);
}

// Scroll to the bottom until `url`'s row is rendered — infinite scroll grows the
// page as the last row nears the viewport, so this also pages the view.
export async function scrollUntilRendered(page: Page, scroller: Locator, url: string) {
  await expect
    .poll(
      async () => {
        await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
        return await linkRow(page, url).count();
      },
      { timeout: 30_000, intervals: [250] },
    )
    .toBe(1);
}

export async function scrollToTop(scroller: Locator) {
  await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
}

export async function scrollTop(scroller: Locator): Promise<number> {
  return await scroller.evaluate((el) => el.scrollTop);
}

// The viewport claim, in bounds: the scroller is at 0 and the row is painted
// inside its box, not merely present in the DOM (the virtualizer renders an
// overscan past both edges).
export async function expectRowAtTop(page: Page, scroller: Locator, url: string) {
  await expect.poll(() => scrollTop(scroller)).toBe(0);
  const row = linkRow(page, url);
  await expect(row).toBeVisible();
  const box = await scroller.boundingBox();
  const rowBox = await row.boundingBox();
  if (!box || !rowBox) throw new Error('scroller or row has no box');
  expect(rowBox.y).toBeGreaterThanOrEqual(box.y - 1);
  expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(box.y + box.height + 1);
}
