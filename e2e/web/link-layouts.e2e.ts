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

      // --- narrow: the list, the choice kept -----------------------------------
      await page.setViewportSize({ width: 600, height: 900 });
      await expect(grid).toHaveCount(0);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(page.getByRole('table', { name: 'Links' })).toBeVisible();
    },
  );
});
