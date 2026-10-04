import { type Locator, type Page } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { addLink, linkRow, openSidebarItem } from './fixtures/links';

// "Move to" into a list that does not exist yet, through each of the three boxes
// the one picker sits in: the row menu's anchored submenu, the page-level dialog
// the bulk toolbar opens, and the bottom sheet the row menu hands off to below
// `md` (docs/editors.md, _"Move to" creates inline_).
//
// That the create and the move are one gesture, where the list lands, and what a
// blank name does are unit territory (link-row-menu.spec.tsx,
// link-move-surface.spec.tsx). What only a browser shows:
//
//   - both writes landing in a real Dexie and the mounted views reading them
//     back — the new list in the rail, the row gone from the list it left;
//   - Radix's own submenu handler. It closes a submenu on ArrowLeft from anywhere
//     inside, and the picker's field has to keep that key while there is a caret
//     to move. The component spec stands a plain listener in for Radix; this is
//     the real one, in both directions;
//   - a bulk selection surviving the create. Leaving for Settings → Lists exits
//     the mode and drops it, which is the reason the row exists at all;
//   - the `md` fork read off a real matchMedia, not a mocked boolean.

const WIDE = { width: 1280, height: 720 };
const NARROW = { width: 390, height: 844 };

function nameField(page: Page): Locator {
  return page.getByPlaceholder('Search or create lists…');
}

function createRow(page: Page, name: string): Locator {
  return page.getByRole('option', { name: `Create “${name}”` });
}

function bulkToggle(page: Page): Locator {
  return page.getByRole('button', { name: 'Bulk edit', exact: true });
}

async function openRowMenu(page: Page, url: string) {
  await linkRow(page, url).getByRole('button', { name: 'Link options' }).click();
}

// Open the row menu's Move to submenu and put the caret in its field.
//
// The pointer has to TRAVEL there. Radix keeps a submenu open only while the
// pointer is heading for it — it compares the direction of the last pointermove
// inside the parent menu with the side the submenu opened on — and a row menu
// hangs off the right edge of the pane, so its submenu flips to the LEFT. A
// plain `hover()` then `click()` is two teleports: the one move the parent menu
// sees starts from Radix's initial x of 0, reads as "right", and the jump into
// the field is taken for leaving. The parent takes focus back, the submenu
// starts its exit animation with the field still clickable inside it, and the
// run fails a step later on a Create row that is detached mid-click.
// `moveListUnder` (fixtures/taxonomy.ts) gets away with the teleport because
// that submenu opens to the right.
async function openMoveToField(page: Page): Promise<Locator> {
  const moveTo = page.getByRole('menuitem', { name: 'Move to', exact: true });
  const box = await moveTo.boundingBox();
  if (!box) throw new Error('the Move to item has no box');
  const y = box.y + box.height / 2;
  // Right to left across the item, so the direction is real before the leave.
  await page.mouse.move(box.x + box.width - 4, y, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2, y, { steps: 4 });
  const field = nameField(page);
  await expect(field).toBeVisible();
  const target = await field.boundingBox();
  if (!target) throw new Error('the list picker field has no box');
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await field.click();
  await expect(field).toBeFocused();
  return field;
}

test.describe('move to a new list', () => {
  test(
    'a link and a bulk selection are filed into a list created from the Move to picker',
    { tag: ['@LINK-MOVE-001', '@full', '@online'] },
    async ({ page }) => {
      const submenuList = unique('E2e move submenu');
      const bulkList = unique('E2e move bulk');
      const sheetList = unique('E2e move sheet');
      const viaSubmenu = unresolvableUrl(unique('move-submenu'));
      const bulkOne = unresolvableUrl(unique('move-bulk-one'));
      const bulkTwo = unresolvableUrl(unique('move-bulk-two'));
      const viaSheet = unresolvableUrl(unique('move-sheet'));
      const keep = unresolvableUrl(unique('move-keep'));

      await page.setViewportSize(WIDE);
      await page.goto('/links');
      for (const url of [keep, viaSubmenu, bulkOne, bulkTwo, viaSheet]) await addLink(page, url);

      // --- the row menu's submenu ------------------------------------------------
      await openRowMenu(page, viaSubmenu);
      const moveTo = page.getByRole('menuitem', { name: 'Move to', exact: true });

      // With nothing typed there is no caret to move, so ArrowLeft is still the
      // keyboard's way back: the submenu closes and its parent stays.
      await openMoveToField(page);
      await page.keyboard.press('ArrowLeft');
      await expect(nameField(page)).toHaveCount(0);
      await expect(moveTo).toBeVisible();

      // With a name typed the key belongs to the field. Stepping back through it
      // must not close the menu and take the name with it.
      const field = await openMoveToField(page);
      await field.fill(submenuList);
      await page.keyboard.press('ArrowLeft');
      expect(await field.evaluate((input) => (input as HTMLInputElement).selectionStart)).toBe(
        submenuList.length - 1,
      );
      // Read after the caret has moved and the Create row has been found again:
      // a submenu on its way out still holds its field for the length of the
      // exit animation, so the value alone would pass against a closing menu.
      await expect(createRow(page, submenuList)).toBeVisible();
      await expect(field).toBeFocused();
      await expect(field).toHaveValue(submenuList);

      await createRow(page, submenuList).click();
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(linkRow(page, viaSubmenu)).toHaveCount(0);
      await expect(linkRow(page, keep)).toHaveCount(1);

      // --- the bulk toolbar's dialog ---------------------------------------------
      await bulkToggle(page).click();
      await expect(bulkToggle(page)).toHaveAttribute('aria-pressed', 'true');
      for (const url of [bulkOne, bulkTwo]) {
        await linkRow(page, url).getByRole('checkbox', { name: 'Select link' }).click();
      }
      await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
      await page.getByRole('main').getByRole('button', { name: 'Move to', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Move to' });
      await dialog.getByPlaceholder('Search or create lists…').fill(bulkList);
      // Still selected with the name typed: nothing so far has left the view.
      await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
      await createRow(page, bulkList).click();
      await expect(dialog).toHaveCount(0);
      // A completed move ends the mode, like every other bulk write.
      await expect(bulkToggle(page)).toHaveAttribute('aria-pressed', 'false');
      await expect(linkRow(page, bulkOne)).toHaveCount(0);
      await expect(linkRow(page, bulkTwo)).toHaveCount(0);
      await expect(linkRow(page, keep)).toHaveCount(1);

      // --- the narrow sheet ------------------------------------------------------
      await page.setViewportSize(NARROW);
      await openRowMenu(page, viaSheet);
      // Below `md` the item hands off instead of opening a submenu, and says so
      // with its ellipsis.
      await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Move to' });
      await expect(sheet).toBeVisible();
      await sheet.getByPlaceholder('Search or create lists…').fill(sheetList);
      await createRow(page, sheetList).click();
      await expect(sheet).toHaveCount(0);
      await expect(linkRow(page, viaSheet)).toHaveCount(0);
      await expect(linkRow(page, keep)).toHaveCount(1);

      // --- each list holds exactly what was filed into it -------------------------
      await page.setViewportSize(WIDE);
      const filed: [string, string[]][] = [
        [submenuList, [viaSubmenu]],
        [bulkList, [bulkOne, bulkTwo]],
        [sheetList, [viaSheet]],
      ];
      const moved = filed.flatMap(([, urls]) => urls);
      for (const [name, urls] of filed) {
        await openSidebarItem(page, name);
        for (const url of urls) await expect(linkRow(page, url)).toHaveCount(1);
        for (const url of moved.filter((other) => !urls.includes(other))) {
          await expect(linkRow(page, url)).toHaveCount(0);
        }
      }

      // --- after a reload ---------------------------------------------------------
      await page.reload();
      await openSidebarItem(page, bulkList);
      await expect(linkRow(page, bulkOne)).toHaveCount(1);
      await expect(linkRow(page, bulkTwo)).toHaveCount(1);
      await openSidebarItem(page, 'My List');
      await expect(linkRow(page, keep)).toHaveCount(1);
      for (const url of moved) await expect(linkRow(page, url)).toHaveCount(0);
    },
  );
});
