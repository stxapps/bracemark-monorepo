import { TABLE_MIN_PANE_WIDTH } from '@stxapps/shared';

import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { addLink, displayUrl } from './fixtures/links';
import { grantPlusAndLoad } from './fixtures/plan';

// The table layout end to end (docs/link-layouts.md, _the table_): the Plus gate in
// Settings → Appearance, choosing the table, changing its columns, and the header
// sort — over a real store and a real sync, at a wide window. The fallbacks and the
// column fit have unit specs (resolve-layout.spec.ts, layout-options.spec.ts); what
// only a browser shows is the table actually replacing the list, its semantics on
// the virtualized rows, and a column change landing on the page.

test.describe('link layouts', () => {
  test(
    'a free account is offered the upgrade; a Plus account picks the table, changes its columns and sorts by a header',
    { tag: ['@LAYOUT-TABLE-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, credentials } = app;
      await page.setViewportSize({ width: 1440, height: 900 });
      const url = unresolvableUrl(unique('table'));
      await addLink(page, url);

      // --- free: the paywall, and nothing written ------------------------------
      await page.goto('/settings/appearance');
      const table = page.getByRole('radio', { name: /^Table\b/ });
      await table.click();
      const paywall = page.getByRole('dialog', { name: 'Table layout' });
      await expect(paywall).toBeVisible();
      await paywall.getByRole('button', { name: 'Not now' }).click();
      await expect(table).not.toHaveAttribute('data-state', 'checked');

      // --- Plus: the table -----------------------------------------------------
      await grantPlusAndLoad(page, credentials.username);
      await page.goto('/settings/appearance');
      await page.getByRole('radio', { name: /^Table\b/ }).click();
      await expect(page.getByRole('heading', { name: 'Table columns' })).toBeVisible();

      // --- the narrowest table still shows its own defaults --------------------
      // The pane is the scroller's box — the table's parent (role=table sits just
      // inside it, so Show more can follow it in the scroll). Shrink the window by
      // exactly the pane's surplus over the minimum: a table must render, and with
      // every default column — none behind "+N". (A hand-written 840 summed the
      // columns but not their gaps or the row's chrome, so the table opened with
      // Tags hidden up to ~911.)
      await page.goto('/links');
      await expect(page.getByRole('table', { name: 'Links' })).toBeVisible();
      const scroller = page.getByRole('table', { name: 'Links' }).locator('..');
      const wide = await scroller.boundingBox();
      if (!wide) throw new Error('the table has no box');
      await page.setViewportSize({
        width: 1440 - Math.floor(wide.width - TABLE_MIN_PANE_WIDTH),
        height: 900,
      });
      const narrowest = page.getByRole('table', { name: 'Links' });
      await expect
        .poll(async () => Math.round((await scroller.boundingBox())?.width ?? 0))
        .toBe(TABLE_MIN_PANE_WIDTH);
      await expect(narrowest.getByRole('columnheader')).toHaveText([
        'Title',
        'Site',
        'Tags',
        /Modified/,
        'Actions',
      ]);
      await page.setViewportSize({ width: 1440, height: 900 });

      await page.goto('/settings/appearance');
      // Add the Added column; hide Tags.
      await page.locator('#sync-column-createdAt').click();
      await page.locator('#sync-column-tags').click();

      await page.goto('/links');
      const grid = page.getByRole('table', { name: 'Links' });
      await expect(grid).toBeVisible();
      await expect(grid.getByRole('columnheader')).toHaveText([
        'Title',
        'Site',
        /Modified/,
        'Added',
        'Actions',
      ]);
      const row = grid.getByRole('row').filter({ hasText: displayUrl(url) });
      await expect(row).toHaveAttribute('aria-rowindex', '2');

      // The header describes the order IN FORCE, not the setting: a hand-typed
      // `?order=asc` overrides the stored newest-first, and the arrow must say so.
      await page.goto('/links?order=asc');
      await expect(
        page.getByRole('table', { name: 'Links' }).getByRole('columnheader', { name: /Modified/ }),
      ).toHaveAttribute('aria-sort', 'ascending');
      await page.goto('/links');

      // The Modified header sorts (by date modified, newest first by default);
      // pressing it again flips the order.
      const modified = grid.getByRole('columnheader', { name: /Modified/ });
      await expect(modified).toHaveAttribute('aria-sort', 'descending');
      await modified.getByRole('button').click();
      await expect(modified).toHaveAttribute('aria-sort', 'ascending');
      // The Added header switches the field.
      const added = grid.getByRole('columnheader', { name: 'Added' });
      await added.getByRole('button').click();
      await expect(added).toHaveAttribute('aria-sort', 'ascending');
      await expect(modified).not.toHaveAttribute('aria-sort');

      // --- bulk edit: a header over the checkbox column --------------------------
      // Every row gains a checkbox cell first; the header row must gain its header
      // too, or a screen reader reads each cell under the header one to its left.
      await page.getByRole('button', { name: 'Bulk edit' }).click();
      await expect(grid.getByRole('columnheader')).toHaveText([
        'Select',
        'Title',
        'Site',
        /Modified/,
        'Added',
        'Actions',
      ]);
      await expect(row.getByRole('cell')).toHaveCount(6);
      await page.getByRole('button', { name: 'Exit bulk edit' }).click();

      // --- "+N": which chosen columns didn't fit ---------------------------------
      // Add URL (the lowest priority of the four) and narrow the pane to the
      // table's minimum, where Site, Modified and Added fit and URL does not. The
      // chooser behind "+1" keeps URL checked — the choice stands — and says it
      // doesn't fit, so "+1" names which one.
      await page.goto('/settings/appearance');
      await page.locator('#sync-column-url').click();
      await page.goto('/links');
      await expect(grid).toBeVisible();
      await page.setViewportSize({
        width: 1440 - Math.floor(wide.width - TABLE_MIN_PANE_WIDTH),
        height: 900,
      });
      const more = grid.getByRole('button', { name: /^1 column hidden/ });
      await more.click();
      const columnsPopover = page.getByRole('dialog', { name: 'Columns' });
      await expect(columnsPopover.getByRole('checkbox', { name: 'URL Doesn’t fit' })).toBeChecked();
      await expect(
        columnsPopover.getByRole('checkbox', { name: 'Site', exact: true }),
      ).toBeChecked();
      // Hiding URL from here makes the rest fit, so "+1" goes — but the popover
      // and focus must stay where the user is, and closing it must land focus on
      // the button, now "Choose columns".
      await columnsPopover.getByRole('checkbox', { name: 'URL Doesn’t fit' }).click();
      await expect(grid.getByRole('button', { name: 'Choose columns' })).toBeVisible();
      await expect(columnsPopover).toBeVisible();
      await expect(
        columnsPopover.getByRole('checkbox', { name: 'URL', exact: true }),
      ).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(grid.getByRole('button', { name: 'Choose columns' })).toBeFocused();

      // --- narrow: the list, the choice kept, and View options says why ----------
      await page.setViewportSize({ width: 600, height: 900 });
      await expect(grid).toHaveCount(0);
      // Below `md` View options opens from the ⋯ menu.
      await page.getByRole('button', { name: /^More options/ }).click();
      await page.getByRole('menuitem', { name: 'View options' }).click();
      const viewOptions = page.getByRole('dialog', { name: 'View options' });
      // By text: the column chooser's drag-and-drop live region is a status too.
      await expect(
        viewOptions.getByRole('status').filter({ hasText: /too narrow for the table/ }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByRole('table', { name: 'Links' })).toBeVisible();
      await expect(page.getByText(/too narrow for the table/)).toHaveCount(0);
    },
  );
});
