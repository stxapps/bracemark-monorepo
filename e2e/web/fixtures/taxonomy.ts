import { expect, type Locator, type Page } from '@playwright/test';

import { isNarrow } from './layout';

// The Settings → Lists / Tags tables, driven the way a person drives them. Both
// are the same table kit (settings/_components/table-kit.tsx): a create row, then
// one uncontrolled rename field per entity.

type Noun = 'list' | 'tag';

// The rename field for one entity. The fields are uncontrolled, so they match
// on the `value` attribute React writes from `defaultValue` — Playwright has no
// Testing Library `getByDisplayValue`. The row key carries the stored name, so a
// committed rename remounts the field and this locator follows the new value.
export function nameField(page: Page, noun: Noun, name: string): Locator {
  const label = noun === 'list' ? 'List name' : 'Tag name';
  return page.locator(`input[aria-label="${label}"][value="${name}"]`);
}

// The table row holding that field — its grip, collapse toggle and kebab.
export function settingsRow(page: Page, noun: Noun, name: string): Locator {
  return page.locator('li').filter({ has: nameField(page, noun, name) });
}

export async function createInSettings(page: Page, noun: Noun, name: string): Promise<void> {
  await page.goto(`/settings/${noun}s`);
  const create = page.getByLabel(`New ${noun} name`);
  await create.fill(name);
  await create.press('Enter');
  await expect(nameField(page, noun, name)).toBeVisible();
}

// Rename commits on blur; Enter blurs.
export async function renameInSettings(page: Page, noun: Noun, from: string, to: string) {
  const field = nameField(page, noun, from);
  await field.fill(to);
  await field.press('Enter');
  await expect(nameField(page, noun, to)).toBeVisible();
  await expect(nameField(page, noun, from)).toHaveCount(0);
}

// Lock one list from its row kebab. `hide` ticks the dialog's collapse-from-
// sidebar opt-in. The account must be on Plus: the item routes a free account to
// the paywall before any password field exists.
export async function lockListInSettings(
  page: Page,
  name: string,
  password: string,
  options: { hide?: boolean } = {},
): Promise<void> {
  await page.goto('/settings/lists');
  const row = settingsRow(page, 'list', name);
  await row.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Lock list…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Lock list' });
  await dialog.getByLabel('Password', { exact: true }).fill(password);
  if (options.hide) await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Lock', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByLabel('Locked', { exact: true })).toBeVisible();
}

// Unlock through the row kebab's "Unlock…" — the settings path, as opposed to the
// links page's in-place lock pane.
export async function unlockListInSettings(page: Page, name: string, password: string) {
  await page.goto('/settings/lists');
  const row = settingsRow(page, 'list', name);
  await row.getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Unlock…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Unlock list' });
  await dialog.getByLabel('Password', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByLabel('Unlocked', { exact: true })).toBeVisible();
}

// Reparent through the row kebab's Move to: a submenu when wide, and below `md`
// an item that hands off to the Move to sheet, saying so with its ellipsis
// (lists-section.tsx) — the shape the link row menu takes too.
export async function moveListUnder(page: Page, child: string, parent: string) {
  await page.goto('/settings/lists');
  await settingsRow(page, 'list', child).getByRole('button', { name: 'List actions' }).click();
  if (isNarrow(page)) {
    await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
    // Named for the list it moves, unlike the link row's sheet.
    const sheet = page.getByRole('dialog', { name: `Move “${child}” to` });
    await sheet.getByRole('option', { name: parent, exact: true }).click();
    await expect(sheet).toHaveCount(0);
  } else {
    await page.getByRole('menuitem', { name: 'Move to' }).hover();
    await page.getByRole('option', { name: parent, exact: true }).click();
  }
  await expect(
    settingsRow(page, 'list', parent).getByRole('button', { name: 'Collapse' }),
  ).toBeVisible();
}

// The list/tag names as the table renders them, top to bottom.
export async function settingsOrder(page: Page, noun: Noun): Promise<string[]> {
  const label = noun === 'list' ? 'List name' : 'Tag name';
  return await page
    .locator(`input[aria-label="${label}"]`)
    .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
}
