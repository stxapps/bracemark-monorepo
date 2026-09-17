import { type Page } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { addLink, chooseRowMenuItem, linkRow, openSidebarItem } from './fixtures/links';

// One link walked through every state a user can put it in, against a real
// Dexie and a mounted links page. Each step is one `update({ listId })` or a pin
// write (docs/editors.md), so what is proven here is not the mutation — that has
// its own specs — but that the live read of each system list agrees with it as
// the user moves between them, and that the final permanent delete survives a
// reload.
async function expectOnlyIn(page: Page, url: string, here: string, notHere: string) {
  await openSidebarItem(page, notHere);
  await expect(linkRow(page, url)).toHaveCount(0);
  await openSidebarItem(page, here);
  await expect(linkRow(page, url)).toHaveCount(1);
}

test.describe('link lifecycle', () => {
  test(
    'pin, archive, unarchive, remove, restore and delete one link permanently',
    { tag: ['@LINK-LIFECYCLE-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      // Its own account: Trash's permanent delete is the one irreversible step in
      // the journey, and nothing it does should be able to reach a link another
      // spec in this worker is looking at.
      const { page } = app;
      const url = unresolvableUrl(unique('lifecycle'));
      // Sits in Trash for the whole case, so that after the final reload "the
      // deleted link is absent from Trash" is read off a Trash that has visibly
      // loaded.
      const anchor = unresolvableUrl(unique('lifecycle-trash-anchor'));

      await page.goto('/links');
      await addLink(page, anchor);
      await chooseRowMenuItem(page, anchor, 'Remove');
      await expect(linkRow(page, anchor)).toHaveCount(0);

      await addLink(page, url);

      // --- pin --------------------------------------------------------------------
      await chooseRowMenuItem(page, url, 'Pin to top');
      await expect(linkRow(page, url).getByLabel('Pinned')).toBeVisible();
      await expect(linkRow(page, url)).toHaveCount(1);

      // --- archive / unarchive ----------------------------------------------------
      await chooseRowMenuItem(page, url, 'Archive');
      await expect(linkRow(page, url)).toHaveCount(0);
      await expectOnlyIn(page, url, 'Archive', 'My List');

      await chooseRowMenuItem(page, url, 'Unarchive');
      await expect(linkRow(page, url)).toHaveCount(0);
      await expectOnlyIn(page, url, 'My List', 'Archive');

      // --- remove / restore -------------------------------------------------------
      await chooseRowMenuItem(page, url, 'Remove');
      await expect(linkRow(page, url)).toHaveCount(0);
      await expectOnlyIn(page, url, 'Trash', 'My List');

      await chooseRowMenuItem(page, url, 'Restore');
      await expect(linkRow(page, url)).toHaveCount(0);
      await expectOnlyIn(page, url, 'My List', 'Trash');

      // --- permanent delete, through the confirmation -----------------------------
      await chooseRowMenuItem(page, url, 'Remove');
      await openSidebarItem(page, 'Trash');
      await chooseRowMenuItem(page, url, 'Delete permanently');
      const confirm = page.getByRole('alertdialog', { name: 'Delete permanently?' });
      await confirm.getByRole('button', { name: 'Delete permanently', exact: true }).click();
      await expect(confirm).toHaveCount(0);
      await expect(linkRow(page, url)).toHaveCount(0);
      await expect(linkRow(page, anchor)).toHaveCount(1);

      // --- gone after a reload, from every view it passed through -----------------
      await page.reload();
      await expect(linkRow(page, anchor)).toHaveCount(1);
      await expect(linkRow(page, url)).toHaveCount(0);
      for (const view of ['My List', 'Archive']) {
        await openSidebarItem(page, view);
        await expect(linkRow(page, url)).toHaveCount(0);
      }
    },
  );
});
