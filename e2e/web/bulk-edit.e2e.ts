import { type Locator, type Page } from '@playwright/test';

import { importArchive } from '../seed/steps';
import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { isNarrow } from './fixtures/layout';
import { writePagedLibrary } from './fixtures/library';
import {
  addLink,
  addLinkButton,
  chooseRowMenuItem,
  linkRow,
  openSidebarItem,
} from './fixtures/links';
import { scrollerOf, scrollToTop, scrollUntilRendered } from './fixtures/scroll';
import { createInSettings } from './fixtures/taxonomy';

// Bulk edit against a real Dexie and a real virtualizer. The selection
// arithmetic, the per-action eligibility filters and the retag diff are unit
// territory (view-state-provider and the toolbar's specs); what only a browser
// shows is the selection living in hoisted state while its rows unmount, each
// batched write landing as the views read it back, the destroy confirmation, and
// the platform clipboard (docs/editors.md, _bulk edit_).

function selectBox(page: Page, url: string): Locator {
  return linkRow(page, url).getByRole('checkbox', { name: 'Select link' });
}

function bulkToggle(page: Page): Locator {
  return page.getByRole('button', { name: 'Bulk edit', exact: true });
}

async function enterBulkEdit(page: Page) {
  await bulkToggle(page).click();
  await expect(bulkToggle(page)).toHaveAttribute('aria-pressed', 'true');
}

// Select exactly these rows, in this order.
async function select(page: Page, urls: string[]) {
  for (const url of urls) {
    await selectBox(page, url).click();
    await expect(selectBox(page, url)).toBeChecked();
  }
  await expect(page.getByText(`${urls.length} selected`, { exact: true })).toBeVisible();
}

// A bulk toolbar button. Scoped to `main`: "Archive" and "Trash" are rail rows too.
function toolbarButton(page: Page, name: string): Locator {
  return page.getByRole('main').getByRole('button', { name, exact: true });
}

// The actions a pane under the toolbar's COLLAPSE_WIDTH (900px) folds into its ⋯
// (bulk-edit-toolbar.tsx). Every narrow window is under it and the desktop
// window's pane is not, so the window decides, never the menu's visibility.
const OVERFLOWED = new Set(['Edit tags', 'Pin', 'Unpin', 'Archive']);

// Press one toolbar action, inline or from the overflow menu.
async function pressAction(page: Page, name: string) {
  if (isNarrow(page) && OVERFLOWED.has(name)) {
    await toolbarButton(page, 'More actions').click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  } else {
    await toolbarButton(page, name).click();
  }
}

// Run one toolbar action. Every write action ends the mode on success
// (`runBulk` → exitBulkEdit), so the mode ending is the settled state.
async function runAction(page: Page, name: string) {
  await pressAction(page, name);
  await expect(bulkToggle(page)).toHaveAttribute('aria-pressed', 'false');
}

// The pinned block, top to bottom — rows in the virtualizer's own order that
// carry the pinned badge.
async function pinnedOrder(page: Page): Promise<string[]> {
  return await page.locator('[data-index]').evaluateAll((rows) =>
    rows
      .sort((a, b) => Number(a.getAttribute('data-index')) - Number(b.getAttribute('data-index')))
      .filter((row) => row.querySelector('[aria-label="Pinned"]'))
      .map((row) => row.querySelector('a[href]')?.getAttribute('href') ?? ''),
  );
}

async function addTagged(page: Page, url: string, tags: string[]) {
  await addLinkButton(page).click();
  await page.locator('#link-url').fill(url);
  await page.getByRole('button', { name: 'List, tags & note' }).click();
  await page.getByRole('combobox', { name: 'Tags' }).click();
  for (const tag of tags) {
    await page.getByPlaceholder('Search or create tags…').fill(tag);
    await page.getByRole('option', { name: tag, exact: true }).click();
  }
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
  await expect(page.locator('#link-url')).toHaveCount(0);
}

test.describe('bulk edit', () => {
  test(
    'a clicked, range-extended and select-all selection survives virtualization in a fixed view',
    { tag: ['@BULK-001', '@full', '@online', '@destructive', '@scale'] },
    async ({ isolatedApp: app }, testInfo) => {
      const { page } = app;
      const library = await writePagedLibrary(testInfo.outputPath('bulk.zip'), {
        count: 80,
        label: 'bulkfix',
      });
      const urls = library.urls;
      const last = urls[urls.length - 1];
      await importArchive(page, library.archivePath);
      await page.goto('/links');
      await expect(linkRow(page, urls[0])).toBeVisible();
      const view = page.url();

      await enterBulkEdit(page);
      await selectBox(page, urls[0]).click();
      // Shift extends a range over the displayed order.
      await selectBox(page, urls[4]).click({ modifiers: ['Shift'] });
      await expect(page.getByText('5 selected', { exact: true })).toBeVisible();

      // --- scroll the selection out of the DOM and back -------------------------
      const scroller = await scrollerOf(linkRow(page, urls[0]));
      await scrollUntilRendered(page, scroller, last);
      // Unmounted, not merely scrolled past.
      await expect(linkRow(page, urls[0])).toHaveCount(0);
      await expect(page.getByText('5 selected', { exact: true })).toBeVisible();

      await scrollToTop(scroller);
      for (const url of urls.slice(0, 5)) await expect(selectBox(page, url)).toBeChecked();
      await expect(selectBox(page, urls[5])).not.toBeChecked();
      // The view held still under the mode: same URL, same first row.
      expect(page.url()).toBe(view);
      await expect(page.locator('[data-index="0"]')).toContainText(urls[0].replace('https://', ''));

      // --- Select all takes every loaded row -----------------------------------
      await page.getByRole('checkbox', { name: 'Select all' }).click();
      await expect(page.getByText(`${urls.length} selected`, { exact: true })).toBeVisible();
      await scrollUntilRendered(page, scroller, last);
      await expect(selectBox(page, last)).toBeChecked();
    },
  );

  test(
    'batch pin, unpin, retag, move, archive and remove change only the eligible links',
    { tag: ['@BULK-ACTIONS-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page } = app;
      const list = unique('E2e bulk list');
      const shared = unique('e2e-bulk-shared');
      const partial = unique('e2e-bulk-partial');
      const added = unique('e2e-bulk-added');
      const keep = unresolvableUrl(unique('bulk-keep'));
      const pinnedFirst = unresolvableUrl(unique('bulk-pinned-first'));
      const pinnedSecond = unresolvableUrl(unique('bulk-pinned-second'));
      const unpinned = unresolvableUrl(unique('bulk-unpinned'));
      const one = unresolvableUrl(unique('bulk-one-tag'));
      const two = unresolvableUrl(unique('bulk-two-tags'));
      const archived = unresolvableUrl(unique('bulk-archived'));

      await createInSettings(page, 'list', list);
      await createInSettings(page, 'tag', shared);
      await createInSettings(page, 'tag', partial);
      await page.goto('/links');
      for (const url of [keep, pinnedFirst, pinnedSecond, unpinned, archived]) {
        await addLink(page, url);
      }
      await addTagged(page, one, [shared]);
      await addTagged(page, two, [shared, partial]);
      await chooseRowMenuItem(page, pinnedFirst, 'Pin to top');
      await chooseRowMenuItem(page, pinnedSecond, 'Pin to top');
      await chooseRowMenuItem(page, archived, 'Archive');
      await expect.poll(() => pinnedOrder(page)).toEqual([pinnedSecond, pinnedFirst]);

      // --- Pin over a mixed selection: only the unpinned one is pinned ----------
      // Re-pinning the already-pinned link would move it to the top; pinning only
      // the eligible one leaves the existing pins' order alone.
      await enterBulkEdit(page);
      await select(page, [pinnedFirst, unpinned]);
      await runAction(page, 'Pin');
      await expect.poll(() => pinnedOrder(page)).toEqual([unpinned, pinnedSecond, pinnedFirst]);

      // --- Unpin over a mixed selection -----------------------------------------
      await enterBulkEdit(page);
      await select(page, [unpinned, keep]);
      await runAction(page, 'Unpin');
      await expect.poll(() => pinnedOrder(page)).toEqual([pinnedSecond, pinnedFirst]);

      // --- Retag: the shared tag is editable, the partial one is untouched ------
      await enterBulkEdit(page);
      await select(page, [one, two]);
      await pressAction(page, 'Edit tags');
      const dialog = page.getByRole('dialog', { name: 'Edit tags' });
      await expect(dialog.getByRole('option', { name: shared, exact: true })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(dialog.getByRole('option', { name: partial, exact: true })).toHaveAttribute(
        'aria-checked',
        'false',
      );
      await dialog.getByRole('option', { name: shared, exact: true }).click();
      await dialog.getByPlaceholder('Search or create tags…').fill(added);
      await dialog.getByRole('option', { name: `Create “${added}”` }).click();
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(linkRow(page, one)).toContainText(added);
      await expect(linkRow(page, one)).not.toContainText(shared);
      await expect(linkRow(page, two)).toContainText(added);
      await expect(linkRow(page, two)).toContainText(partial);
      await expect(linkRow(page, two)).not.toContainText(shared);
      await expect(linkRow(page, keep)).not.toContainText(added);

      // --- Move -----------------------------------------------------------------
      await enterBulkEdit(page);
      await select(page, [one, two]);
      await toolbarButton(page, 'Move to').click();
      const move = page.getByRole('dialog', { name: 'Move to' });
      await move.getByRole('option', { name: list, exact: true }).click();
      await expect(move).toHaveCount(0);
      await expect(linkRow(page, one)).toHaveCount(0);
      await expect(linkRow(page, two)).toHaveCount(0);
      await expect(linkRow(page, keep)).toHaveCount(1);
      await openSidebarItem(page, list);
      await expect(linkRow(page, one)).toHaveCount(1);
      await expect(linkRow(page, two)).toHaveCount(1);

      // --- Archive over a mixed selection, from Show All -------------------------
      await openSidebarItem(page, 'Show All');
      await enterBulkEdit(page);
      await select(page, [one, archived]);
      await runAction(page, 'Archive');
      await openSidebarItem(page, 'Archive');
      await expect(linkRow(page, one)).toHaveCount(1);
      await expect(linkRow(page, archived)).toHaveCount(1);
      await expect(linkRow(page, two)).toHaveCount(0);
      await openSidebarItem(page, list);
      await expect(linkRow(page, two)).toHaveCount(1);
      await expect(linkRow(page, one)).toHaveCount(0);

      // --- Remove ---------------------------------------------------------------
      await enterBulkEdit(page);
      await select(page, [two]);
      await runAction(page, 'Remove');
      await expect(linkRow(page, two)).toHaveCount(0);
      await openSidebarItem(page, 'Trash');
      await expect(linkRow(page, two)).toHaveCount(1);
      await expect(linkRow(page, keep)).toHaveCount(0);

      // The untouched link went through every step unchanged.
      await openSidebarItem(page, 'My List');
      await expect(linkRow(page, keep)).toHaveCount(1);
      await expect(linkRow(page, keep).getByLabel('Pinned')).toHaveCount(0);
    },
  );

  test(
    'Trash restores and permanently deletes a selection through the confirmation',
    { tag: ['@BULK-TRASH-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page } = app;
      const restored = [
        unresolvableUrl(unique('trash-restored-a')),
        unresolvableUrl(unique('trash-restored-b')),
      ];
      const deleted = unresolvableUrl(unique('trash-deleted'));
      // Stays in Trash, so the post-reload absence is read off a Trash that has
      // visibly loaded.
      const kept = unresolvableUrl(unique('trash-kept'));
      const all = [...restored, deleted, kept];

      await page.goto('/links');
      for (const url of all) await addLink(page, url);
      await enterBulkEdit(page);
      await select(page, all);
      await runAction(page, 'Remove');
      await openSidebarItem(page, 'Trash');
      for (const url of all) await expect(linkRow(page, url)).toHaveCount(1);

      // --- Restore --------------------------------------------------------------
      await enterBulkEdit(page);
      await select(page, restored);
      await runAction(page, 'Restore');
      for (const url of restored) await expect(linkRow(page, url)).toHaveCount(0);
      await expect(linkRow(page, deleted)).toHaveCount(1);

      // --- Delete permanently, through the confirmation --------------------------
      await enterBulkEdit(page);
      await select(page, [deleted]);
      await toolbarButton(page, 'Delete permanently').click();
      const confirm = page.getByRole('alertdialog', { name: 'Delete permanently?' });
      await confirm.getByRole('button', { name: 'Delete permanently', exact: true }).click();
      await expect(confirm).toHaveCount(0);
      await expect(linkRow(page, deleted)).toHaveCount(0);
      await expect(linkRow(page, kept)).toHaveCount(1);

      // --- after a reload --------------------------------------------------------
      await page.reload();
      await openSidebarItem(page, 'Trash');
      await expect(linkRow(page, kept)).toHaveCount(1);
      await expect(linkRow(page, deleted)).toHaveCount(0);
      for (const url of restored) await expect(linkRow(page, url)).toHaveCount(0);
      await openSidebarItem(page, 'My List');
      for (const url of restored) await expect(linkRow(page, url)).toHaveCount(1);
      await openSidebarItem(page, 'Show All');
      await expect(linkRow(page, deleted)).toHaveCount(0);
    },
  );

  test(
    'Copy puts the selection’s URLs on the clipboard in display order and stays in the mode',
    { tag: ['@BULK-COPY-001', '@full', '@online'] },
    async ({ app, page }) => {
      await app.context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const oldest = unresolvableUrl(unique('copy-oldest'));
      const middle = unresolvableUrl(unique('copy-middle'));
      const newest = unresolvableUrl(unique('copy-newest'));

      await page.goto('/links');
      for (const url of [oldest, middle, newest]) await addLink(page, url);

      // Selected bottom-up, so click order and display order disagree.
      await enterBulkEdit(page);
      await select(page, [oldest, newest]);
      await toolbarButton(page, 'Copy links').click();

      // The feedback is the button itself; the mode does not end.
      await expect(toolbarButton(page, 'Copied')).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        `${newest}\n${oldest}`,
      );
      await expect(toolbarButton(page, 'Copy links')).toBeVisible();
      await expect(bulkToggle(page)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
      await expect(selectBox(page, oldest)).toBeChecked();
      await expect(selectBox(page, newest)).toBeChecked();
    },
  );
});
