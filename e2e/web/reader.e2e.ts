import { type Locator, type Page } from '@playwright/test';

import { importArchive, waitForSync } from '../seed/steps';
import { expect, test } from './fixtures/app';
import { unique } from './fixtures/data';
import { writeKeptCopiesLibrary } from './fixtures/kept-copies-library';
import { chooseRowMenuItem, linkRow } from './fixtures/links';
import { grantPlusAndLoad } from './fixtures/plan';

// The reader over kept copies that arrived from elsewhere (docs/reader.md). Which
// tabs a link gets, and which one it opens on, is reader-page.spec.tsx's; what only a
// browser shows is the whole path — a copy imported, pushed and read back as
// encrypted `files/` blobs, gunzipped and drawn, a screenshot decoded at its own
// shape, and the tabs laid out with their labels in them at this window's width. The
// last is the claim that went silently wrong on expo (`flex-1 sm:flex-none`,
// docs/theme.md): a trigger that lays out zero wide still exists, still has its
// name, and still passes every role query, so the boxes are measured here.

// A tab is a real target: wide enough to hold its label, on any window.
const MIN_TAB_WIDTH = 48;

function tab(page: Page, name: string): Locator {
  return page.getByRole('tab', { name, exact: true });
}

async function expectTabsLaidOut(page: Page): Promise<void> {
  for (const name of ['Read mode', 'Screenshot']) {
    const box = await tab(page, name).boundingBox();
    expect(box, `the ${name} tab has no box`).not.toBeNull();
    expect(box?.width ?? 0, `the ${name} tab’s width`).toBeGreaterThanOrEqual(MIN_TAB_WIDTH);
  }
}

function screenshot(page: Page, title: string): Locator {
  return page.getByRole('img', {
    name: `Screenshot of ${title}, as it looked when it was saved`,
  });
}

// Decoded, and drawn at the shape it was taken at — not a fixed box's.
async function expectScreenshotDrawn(image: Locator, ratio: number): Promise<void> {
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true);
  const box = await image.boundingBox();
  if (!box) throw new Error('the screenshot has no box');
  expect(Math.abs(box.width / box.height - ratio)).toBeLessThan(0.05);
}

test.describe('reader', () => {
  test(
    'kept copies from a backup read back in tabs, open full size, and delete on their own',
    { tag: ['@READER-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }, testInfo) => {
      // Its own account on Plus: a screenshot-only link has tabs only on a plan that
      // can take the read-mode copy (docs/reader.md, _the tabs_).
      const { page, credentials } = app;
      await grantPlusAndLoad(page, credentials.username);
      const library = await writeKeptCopiesLibrary(
        testInfo.outputPath('kept-copies.zip'),
        unique('E2E reader'),
      );
      await importArchive(page, library.archivePath);
      await waitForSync(page);

      // Both copies: two tabs, opening on Read mode, the article drawn from its blob.
      await page.goto('/links');
      await chooseRowMenuItem(page, library.bothUrl, 'Read');
      await expect(page).toHaveURL(/\/read\?link=/);
      await expect(tab(page, 'Read mode')).toHaveAttribute('aria-selected', 'true');
      await expectTabsLaidOut(page);
      await expect(page.getByRole('heading', { name: library.heading })).toBeVisible();
      await expect(page.getByText(library.sentence)).toBeVisible();

      // The screenshot at its own shape, and full size in a dialog named for the link.
      await tab(page, 'Screenshot').click();
      await expect(tab(page, 'Screenshot')).toHaveAttribute('aria-selected', 'true');
      const image = screenshot(page, library.bothTitle);
      await expectScreenshotDrawn(image, library.shotRatio);
      await image.click();
      const dialog = page.getByRole('dialog', { name: library.bothTitle });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Show at actual size' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      // Deleting the screenshot leaves the read-mode copy, alone and without tabs.
      await page.getByRole('button', { name: 'Delete this screenshot' }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
      await expect(page.getByRole('tab')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: library.heading })).toBeVisible();
      await expect(screenshot(page, library.bothTitle)).toHaveCount(0);

      // A screenshot alone: the same two tabs, opening on the copy that exists, and the
      // Read mode tab holding the way to take one rather than nothing.
      await page.goto('/links');
      await expect(linkRow(page, library.shotOnlyUrl)).toHaveCount(1);
      await chooseRowMenuItem(page, library.shotOnlyUrl, 'Read');
      await expect(tab(page, 'Screenshot')).toHaveAttribute('aria-selected', 'true');
      await expectTabsLaidOut(page);
      await expectScreenshotDrawn(screenshot(page, library.shotOnlyTitle), library.shotRatio);
      await tab(page, 'Read mode').click();
      await expect(
        page.getByRole('button', { name: /^(Keep a read-mode copy|Turn on server read mode)$/ }),
      ).toBeVisible();
    },
  );
});
