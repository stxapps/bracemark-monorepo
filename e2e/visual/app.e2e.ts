import { join } from 'node:path';

import { chromium, type Page } from '@playwright/test';

import { runArtifactDir } from '../paths';
import { importArchive, waitForSync } from '../seed/steps';
import { expect, test } from '../web/fixtures/app';
import { CHROME_PATH, WEB_URL } from '../web/fixtures/env';
import { addLinkButton, chooseRowMenuItem, linkRow } from '../web/fixtures/links';
import { writeVisualLibrary } from '../web/fixtures/visual-library';
import { checkpoint, layoutOf, useLayout } from './fixtures/checkpoint';

// The app's named visual checkpoints on the web (docs/e2e.md, _visual
// checkpoints_), once per layout project. Functional specs own every claim
// about behaviour; this drives to each state by the plainest honest route —
// view changes by URL, which is the view's own address (docs/search.md) — and
// asserts only what it must to know the state has arrived.

const SETTINGS_SECTIONS = ['account', 'data', 'extraction', 'lists', 'tags', 'misc', 'about'];

function fixturePath(name: string): string {
  const runId = process.env.E2E_RUN_ID ?? 'visual-direct';
  return join(process.env.E2E_RUN_DIR ?? runArtifactDir(runId), 'visual', 'fixture', name);
}

async function chooseLayout(page: Page, name: 'List' | 'Card') {
  await page.goto('/settings/misc');
  const radio = page.getByRole('radio', { name: new RegExp(`^${name}\\b`) });
  await radio.click();
  await expect(radio).toBeChecked();
}

test.describe('visual checkpoints', () => {
  test(
    'the app, signed out, empty, populated and in settings',
    { tag: ['@VISUAL-APP-001', '@full', '@online', '@visual', '@baseline', '@destructive'] },
    async ({ isolatedApp: app }) => {
      test.setTimeout(600_000);
      const { page, credentials } = app;

      // --- signed out: a browser with no session -------------------------------
      const browser = await chromium.launch({ executablePath: CHROME_PATH });
      try {
        const guest = await browser.newPage({ baseURL: WEB_URL, deviceScaleFactor: 2 });
        await useLayout(guest);
        await guest.goto('/sign-in');
        await expect(guest.getByRole('button', { name: /sign in/i })).toBeVisible();
        await checkpoint(guest, 'signed-out');
      } finally {
        await browser.close();
      }

      // --- empty ---------------------------------------------------------------
      await useLayout(page);
      await page.goto('/links');
      await expect(page.getByRole('main').getByRole('button', { name: 'Add link' })).toBeVisible();
      await checkpoint(page, 'empty');

      // --- the library -----------------------------------------------------------
      const library = await writeVisualLibrary(fixturePath(`library-${layoutOf()}.zip`));
      await importArchive(page, library.archivePath);
      await waitForSync(page);
      await page.goto('/links');
      await expect(page.getByText(library.landedTitle)).toBeVisible();
      await checkpoint(page, 'populated-list');

      await chooseLayout(page, 'Card');
      await page.goto('/links');
      await expect(page.getByText(library.landedTitle)).toBeVisible();
      await checkpoint(page, 'populated-cards');
      await chooseLayout(page, 'List');

      // --- search ------------------------------------------------------------------
      await page.goto(`/links?text=${library.searchWord}`);
      await expect(page.getByText(library.searchHit)).toBeVisible();
      await expect(page.getByText(library.landedTitle)).toHaveCount(0);
      await checkpoint(page, 'search');

      // --- add, edit ---------------------------------------------------------------
      await page.goto('/links');
      await expect(page.getByText(library.landedTitle)).toBeVisible();
      await addLinkButton(page).click();
      await page.locator('#link-url').fill(library.draftUrl);
      await page.getByRole('button', { name: 'List, tags & note' }).click();
      await expect(page.getByRole('textbox', { name: 'Note' })).toBeVisible();
      await checkpoint(page, 'add');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.locator('#link-url')).toHaveCount(0);

      await chooseRowMenuItem(page, 'https://field-notes.invalid/reading-slowly', 'Edit');
      const dialog = page.getByRole('dialog', { name: 'Edit link' });
      await expect(dialog.getByRole('textbox', { name: 'Note' })).toHaveValue(
        'Chapter three first.',
      );
      await checkpoint(page, 'edit');
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toHaveCount(0);

      // --- bulk mode -------------------------------------------------------------------
      const bulk = page.getByRole('button', { name: 'Bulk edit', exact: true });
      await bulk.click();
      await expect(bulk).toHaveAttribute('aria-pressed', 'true');
      for (const url of [
        'https://kitchen-log.invalid/sourdough',
        'https://slow-travel.invalid/harbour-walk',
      ]) {
        const box = linkRow(page, url).getByRole('checkbox', { name: 'Select link' });
        await box.click();
        await expect(box).toBeChecked();
      }
      await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
      await checkpoint(page, 'bulk-mode');
      await bulk.click();
      await expect(bulk).toHaveAttribute('aria-pressed', 'false');

      // --- settings --------------------------------------------------------------------
      for (const section of SETTINGS_SECTIONS) {
        await page.goto(`/settings/${section}`);
        await expect(page.getByRole('main').getByRole('heading').first()).toBeVisible();
        if (section === 'data') await expect(page.getByText(/^Last synced/)).toBeVisible();
        await checkpoint(page, `settings-${section}`, { username: credentials.username });
      }

      // --- the delete receipt ------------------------------------------------------------
      await page.goto('/settings/data');
      await page.getByRole('button', { name: /^Delete all data/ }).click();
      await page.locator('#delete-confirm').check();
      await page.getByRole('button', { name: 'Delete all data', exact: true }).click();
      await expect(page.getByText(/All your data has been deleted/)).toBeVisible({
        timeout: 60_000,
      });
      await checkpoint(page, 'delete-receipt');
    },
  );
});
