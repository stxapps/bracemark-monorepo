import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { addLink, displayUrl } from './fixtures/links';

// Adding a link is the app's core write. It is here — and not in a component spec —
// for one reason: the write goes through Dexie and has to still be there after a
// reload, which needs a real IndexedDB in a real browser. The form's own behaviour
// (validation, the Save → Confirm relabel on a malformed URL) belongs in a
// component spec, and should be written there rather than added to this file.
test.describe('links', () => {
  test('a link added through the topbar survives a reload', async ({ page }) => {
    const url = unresolvableUrl('added-through-the-topbar');

    await page.goto('/links');
    await addLink(page, url);

    await page.reload();
    await expect(page.getByText(displayUrl(url))).toBeVisible();
  });

  test('two links added in one session are both listed', async ({ page }) => {
    // Distinct paths are enough to tell untitled links apart. Asserting on both —
    // rather than on a count — is what keeps this safe beside the other specs
    // sharing this worker's account.
    const first = unresolvableUrl(unique('first'));
    const second = unresolvableUrl(unique('second'));

    await page.goto('/links');
    await addLink(page, first);
    await addLink(page, second);

    await page.reload();
    await expect(page.getByText(displayUrl(first))).toBeVisible();
    await expect(page.getByText(displayUrl(second))).toBeVisible();
  });
});
