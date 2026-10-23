import { expect, test } from './fixtures/app';
import { unique } from './fixtures/data';
import { openNavigation } from './fixtures/layout';

// Lists cross two surfaces that no single component spec covers together: the
// settings editor writes one, and the links sidebar reads it back through the
// live-query layer (docs/client-queries.md). The value here is the round trip, so
// keep this spec about "created there, visible here" and push editor mechanics —
// validation, the rename commit, tree drag-and-drop — down to component specs.
test.describe('lists', () => {
  test(
    'a list created in settings shows up in the links sidebar',
    { tag: ['@WEB-TAXONOMY-001', '@full', '@online'] },
    async ({ page }) => {
      const name = unique('E2e list');

      await page.goto('/settings/lists');
      const create = page.getByLabel('New list name');
      await create.fill(name);
      await create.press('Enter');

      // Rows are uncontrolled inputs, so match on the value attribute — Playwright
      // has no Testing Library `getByDisplayValue`.
      await expect(page.locator(`input[aria-label="List name"][value="${name}"]`)).toBeVisible();

      await page.goto('/links');
      // The rail, or narrow the drawer the page title opens (fixtures/layout.ts).
      const navigation = await openNavigation(page);
      await expect(navigation.getByRole('button', { name, exact: true })).toBeVisible();
    },
  );
});
