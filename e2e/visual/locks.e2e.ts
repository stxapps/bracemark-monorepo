import { join } from 'node:path';

import { runArtifactDir } from '../paths';
import { importArchive, waitForSync } from '../seed/steps';
import { expect, test } from '../web/fixtures/app';
import { grantPlusAndLoad } from '../web/fixtures/plan';
import { lockListInSettings } from '../web/fixtures/taxonomy';
import { writeVisualLibrary } from '../web/fixtures/visual-library';
import { checkpoint, layoutOf, useLayout } from './fixtures/checkpoint';

// The lock surfaces' visual checkpoints — the set-lock dialog, the app gate and
// a locked list's pane (docs/e2e.md, _visual checkpoints_). Both locks are Plus
// levers, so the account takes the manual grant first (web/fixtures/plan.ts).
// What the locks DO is LOCK-APP-001's and LOCK-LIST-001's.

const LOCK_PASSWORD = 'visual-lock-password';

test.describe('visual checkpoints', () => {
  test(
    'the app lock dialog and gate, and a locked list',
    { tag: ['@VISUAL-LOCK-001', '@full', '@online', '@visual', '@baseline', '@destructive'] },
    async ({ isolatedApp: app }) => {
      test.setTimeout(600_000);
      const { page, credentials } = app;
      await useLayout(page);
      await grantPlusAndLoad(page, credentials.username);

      const runDir = process.env.E2E_RUN_DIR ?? runArtifactDir(process.env.E2E_RUN_ID ?? '');
      const library = await writeVisualLibrary(
        join(runDir, 'visual', 'fixture', `locks-${layoutOf()}.zip`),
      );
      await importArchive(page, library.archivePath);
      await waitForSync(page);

      // --- a locked list -------------------------------------------------------------
      // First, because the app lock below re-engages on every load, and every
      // step here is one.
      await lockListInSettings(page, library.privateList, LOCK_PASSWORD);
      await page.goto(`/links?list=${library.privateListId}`);
      await expect(page.getByRole('heading', { name: 'This list is locked' })).toBeVisible();
      await checkpoint(page, 'list-lock');

      // --- the set-lock dialog, then the gate it arms ------------------------------
      await page.goto('/settings/misc');
      await page.getByRole('button', { name: 'Set app lock…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Set app lock' });
      await expect(dialog.getByLabel('Password', { exact: true })).toBeVisible();
      await checkpoint(page, 'app-lock-dialog');
      await dialog.getByLabel('Password', { exact: true }).fill(LOCK_PASSWORD);
      await dialog.getByRole('button', { name: 'Set lock', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Remove app lock…' })).toBeVisible();

      await page.goto('/links');
      await expect(page.getByRole('heading', { name: 'Bracemark is locked' })).toBeVisible();
      await checkpoint(page, 'app-lock');
    },
  );
});
