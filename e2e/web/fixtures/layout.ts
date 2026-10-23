import { expect, type Locator, type Page } from '@playwright/test';

import { readVisualCatalog } from '../../runner/visual-catalog';
import { type E2EWidth } from '../../runner/width';

// The two windows bracemark-web is driven at (docs/e2e.md, _narrow and wide_).
// The web app changes shape at ONE width — `md`, its `MD_QUERY` — and below it
// the links rail is a drawer behind the page title, search is a row the topbar
// summons, quick-add is a bottom sheet, Move to is a sheet, and the settings
// rail is a section menu. A case admitted `narrow` in cases.json runs in the
// `narrow` project as well (playwright.config.ts), and the helpers here are how
// one spec drives both shapes.
//
// ⚠ They branch on the WINDOW THE HARNESS SET, never on what is visible. The
// drawer button exists only below `md`, so "if it's visible, press it" reads
// false while a sheet is still leaving and the next step times out — sometimes.
// The native flows have the same rule for the same reason (E2E_WIDTH).

// The sizes, from the visual catalog: the visual run's two layouts are the
// functional run's two windows, so a checkpoint and a case see the same page.
export const WEB_VIEWPORTS: Record<E2EWidth, { width: number; height: number }> =
  readVisualCatalog().profiles.web.layouts;

// `MD_QUERY` (web-ui use-media-query.ts) is `(min-width: 48rem)` at the 16px
// root, re-spelled rather than imported: e2e never imports the app.
const WEB_MD = 768;

export function isNarrow(page: Page): boolean {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('page has no viewport');
  return viewport.width < WEB_MD;
}

// The surface holding the lists and tags: the docked rail when wide; the drawer
// when narrow, opened from the page title (sidebar-drawer.tsx), whose name is
// the current view's. Open until a row is picked or it is dismissed.
export async function openNavigation(page: Page): Promise<Locator> {
  if (!isNarrow(page)) return page.getByRole('complementary');
  await page.getByRole('banner').getByRole('heading', { level: 1 }).getByRole('button').click();
  const drawer = page.getByRole('dialog', { name: 'Lists and tags' });
  await expect(drawer).toBeVisible();
  return drawer;
}

// One Settings section, chosen the way a person at this width chooses it: the
// rail's link when wide, the topbar's section menu when narrow (settings
// _panes/topbar.tsx). That topbar is a `header` inside `main`, so it is no
// `banner`; it is found by the ✕ it holds.
export async function openSettingsSection(page: Page, label: string): Promise<void> {
  if (isNarrow(page)) {
    await page
      .locator('header')
      .filter({ has: page.getByRole('link', { name: 'Close settings' }) })
      .locator('button[aria-haspopup="menu"]')
      .click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  } else {
    await page.getByRole('navigation').getByRole('link', { name: label, exact: true }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: label, exact: true })).toBeVisible();
}

// The links page's search box, ready to type into. Wide, it sits in the topbar.
// Narrow, the topbar's toggle summons it as a row (links _panes/topbar.tsx), so
// call this with the row CLOSED — the toggle is "Close search" while it is up,
// and pressing that would dismiss the search instead.
export async function openSearchBox(page: Page): Promise<Locator> {
  const box = page.getByRole('textbox', { name: 'Search links' });
  if (isNarrow(page)) {
    await page.getByRole('banner').getByRole('button', { name: 'Search links' }).click();
    await expect(box).toBeFocused();
  }
  return box;
}
