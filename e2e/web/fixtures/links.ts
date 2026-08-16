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
