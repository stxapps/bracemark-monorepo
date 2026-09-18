import { expect, type Locator, type Page } from '@playwright/test';

// The topbar's quick-add trigger.
//
// Scoped to the banner because there are TWO "Add link" buttons on an empty links
// page — the topbar's and the empty-state CTA in `main` — and an unscoped
// `getByRole` is a strict-mode violation, not a lucky first match. They open the
// same surface, so this is disambiguation rather than a preference; a spec that
// wants to prove the empty-state CTA works should target `main` and say so.
//
// It also doubles as the signed-in assertion: it only renders for an
// authenticated session.
export function addLinkButton(page: Page): Locator {
  return page.getByRole('banner').getByRole('button', { name: 'Add link' });
}

// Add a link through the topbar's quick-add surface and wait for the row.
//
// Shared by the web specs and the contract runner, which is the only reason it is
// a helper rather than inline steps: the contract run has to create the SAME
// artefact a spec creates, or "the phone can read what the browser wrote" is
// proving something narrower than it claims.
export async function addLink(page: Page, url: string): Promise<void> {
  await addLinkButton(page).click();
  await page.locator('#link-url').fill(url);
  // The button relabels Save → Confirm when the URL looks malformed, and the
  // second click is what commits it. A `.invalid` host doesn't trip that, but
  // matching both keeps the helper usable for a spec that deliberately does.
  await page.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
  await expect(page.getByText(displayUrl(url))).toBeVisible();
}

// What an untitled link renders as: the URL with the scheme stripped (host +
// path). This mirrors the app's own `displayUrl`, deliberately re-spelled rather
// than imported — e2e may use `@stxapps/shared` for addressing but never for
// expectations, or it stops being able to catch a change in this exact rule.
// See docs/e2e.md, "what e2e may not assert".
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

// The rendered row for one link, by the anchor it wraps. `[data-index]` is the
// virtualizer's own row attribute in both layouts, and the href is the stored
// URL — so this finds a row whatever its title currently resolves to, which is
// what an edit that sets a custom title needs.
export function linkRow(page: Page, url: string): Locator {
  return page.locator('[data-index]').filter({ has: page.locator(`a[href="${url}"]`) });
}

// Open one row's options menu and pick an item. `exact` matters twice over:
// "Archive" is a substring of "Unarchive", and "Edit" of "Edit tags"/"Edit note".
export async function chooseRowMenuItem(page: Page, url: string, item: string): Promise<void> {
  const row = linkRow(page, url);
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Link options' }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

// Select a list or tag from the sidebar rail — an in-app navigation, not a
// reload, so a spec that uses it is still asserting on the mounted page. Names
// are exact because namespaced fixture names can share a prefix; `aria-current`
// is the settled state, since the rows below repaint a beat after the click.
// Scoped to the rail's `nav`: a row's tag chips are buttons named by the tag too.
export async function openSidebarItem(page: Page, name: string): Promise<void> {
  const item = page.getByRole('navigation').getByRole('button', { name, exact: true });
  await item.click();
  await expect(item).toHaveAttribute('aria-current', 'true');
}

// Create a list from an open list picker's search box. Both editors pass
// `allowCreate`, and the pick is immediate: the entity is written the moment the
// Create row is chosen (docs/editors.md, _the web pickers create IMMEDIATELY_).
export async function createListInPicker(scope: Page | Locator, page: Page, name: string) {
  const list = scope.getByRole('combobox', { name: 'List' });
  await list.click();
  await page.getByPlaceholder('Search or create lists…').fill(name);
  await page.getByRole('option', { name: `Create “${name}”` }).click();
  await expect(list).toContainText(name);
}

// Create a tag from the tag picker and close it again. The picker stays open
// across picks (tags are a set), so Escape is the close; the chosen token's
// Remove button is the settled state.
export async function createTagInPicker(scope: Page | Locator, page: Page, name: string) {
  await scope.getByRole('combobox', { name: 'Tags' }).click();
  await page.getByPlaceholder('Search or create tags…').fill(name);
  await page.getByRole('option', { name: `Create “${name}”` }).click();
  await expect(scope.getByRole('button', { name: `Remove ${name}` })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByPlaceholder('Search or create tags…')).toHaveCount(0);
}
