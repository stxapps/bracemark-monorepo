import { profileDir } from '../paths';
import { waitForSync } from '../seed/steps';
import { expect, test } from './fixtures/app';
import { unique } from './fixtures/data';
import { writeOverCapBookmarks, writeSmallDataArchive } from './fixtures/data-lifecycle';
import { API_URL } from './fixtures/env';
import { launchApp } from './fixtures/launch';

test.describe('data lifecycle', () => {
  // Account creation is fixture setup and Argon2id-backed, so an in-test
  // `setTimeout` starts too late to cover it. This budget includes fixture
  // setup as well as the import and independent-profile sync boundary.
  test.describe.configure({ timeout: 4 * 60 * 1000 });

  test(
    'imports a Bracemark archive, paints every carried surface, and syncs it to another profile',
    { tag: ['@DATA-IMPORT-WEB-001', '@full', '@online'] },
    async ({ isolatedApp: writer }, testInfo) => {
      const fixture = await writeSmallDataArchive(
        testInfo.outputPath('small-bracemark.zip'),
        unique('E2E data'),
      );

      await writer.page.goto('/settings/data');
      await writer.page.getByRole('button', { name: /^Import data/ }).click();
      await writer.page.locator('input[type=file]').setInputFiles(fixture.archivePath);
      await expect(
        writer.page.getByText(/^Imported 1 link and 1 file\. Added 1 list and 1 tag\./),
      ).toBeVisible({ timeout: 60_000 });

      await writer.page.goto('/links');
      await expect(writer.page.getByText(fixture.linkTitle, { exact: true })).toBeVisible();
      const writerNavigation = writer.page.getByRole('navigation');
      await expect(writerNavigation.getByRole('button', { name: fixture.listName })).toBeVisible();
      await expect(writerNavigation.getByRole('button', { name: fixture.tagName })).toBeVisible();
      await expect(writer.page.locator('img[src^="blob:"]')).toHaveCount(1);

      await waitForSync(writer.page);
      const reader = await launchApp(profileDir(`data-import-reader-w${testInfo.workerIndex}`), {
        existing: writer.credentials,
      });
      try {
        await reader.page.goto('/links');
        await expect(reader.page.getByText(fixture.linkTitle, { exact: true })).toBeVisible();
        const readerNavigation = reader.page.getByRole('navigation');
        await expect(
          readerNavigation.getByRole('button', { name: fixture.listName }),
        ).toBeVisible();
        await expect(readerNavigation.getByRole('button', { name: fixture.tagName })).toBeVisible();
        await expect(reader.page.locator('img[src^="blob:"]')).toHaveCount(1, {
          timeout: 30_000,
        });
      } finally {
        await reader.close();
      }
    },
  );

  test(
    'cancels an over-cap interop import without a write, then imports what fits',
    { tag: ['@DATA-IMPORT-WEB-002', '@full', '@online'] },
    async ({ isolatedApp: app }, testInfo) => {
      const namespace = unique('E2E quota');
      const path = testInfo.outputPath('over-cap-bookmarks.html');
      const fixture = await writeOverCapBookmarks(path, namespace);
      const prompt = app.page.getByText(/This file has 201 new links\./);

      await app.page.goto('/settings/data');
      await app.page.getByRole('button', { name: /^Import data/ }).click();
      await app.page.locator('input[type=file]').setInputFiles(path);
      await expect(prompt).toContainText('there is room for 200 more');
      await app.page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(prompt).toHaveCount(0);

      await app.page.goto('/links');
      await expect(app.page.getByText(fixture.firstTitle, { exact: true })).toHaveCount(0);

      await app.page.goto('/settings/data');
      await app.page.getByRole('button', { name: /^Import data/ }).click();
      await app.page.locator('input[type=file]').setInputFiles(path);
      await expect(prompt).toBeVisible();
      await app.page.getByRole('button', { name: 'Import 200 links' }).click();
      await expect(
        app.page.getByText(/^Imported 200 links\. 1 more link in the file was left out/),
      ).toBeVisible({ timeout: 60_000 });

      await app.page.goto('/links');
      await expect(app.page.getByText(fixture.firstTitle, { exact: true })).toBeVisible();
    },
  );

  test(
    'keeps a run on screen when its view is left and reopened, and never starts a second',
    { tag: ['@DATA-IMPORT-WEB-003', '@full', '@online'] },
    async ({ isolatedApp: app }, testInfo) => {
      const namespace = unique('E2E reopen');
      const path = testInfo.outputPath('reopen-bookmarks.html');
      const fixture = await writeOverCapBookmarks(path, namespace, 3);
      const importData = app.page.getByRole('button', { name: /^Import data/ });
      const chooseFile = app.page.getByRole('button', { name: 'Choose a file' });
      const refreshing = app.page.getByText('Refreshing from the server…');

      await app.page.goto('/settings/data');
      // Hold the api, so the run is still in its opening sync refresh when the
      // view comes back, whatever the machine's speed. Delayed, never answered
      // for it: every request still reaches the real api once released.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const api = `${API_URL}/**`;
      await app.page.route(api, async (route) => {
        await held;
        await route.continue().catch(() => undefined);
      });

      await importData.click();
      await app.page.locator('input[type=file]').setInputFiles(path);
      await expect(refreshing).toBeVisible();

      // Back to the Data overview unmounts the import view; the run goes on.
      // Reopened, the view must show that run, not an idle picker that would
      // start a second one against a library the first hasn't finished writing.
      await app.page.getByRole('button', { name: 'Data', exact: true }).click();
      await expect(chooseFile).toHaveCount(0);
      await importData.click();
      await expect(refreshing).toBeVisible();
      await expect(chooseFile).toBeDisabled();

      release();
      await app.page.unroute(api);
      await expect(app.page.getByText(/^Imported 3 links\./)).toBeVisible({ timeout: 60_000 });

      await app.page.goto('/links');
      await expect(app.page.getByText(fixture.firstTitle, { exact: true })).toHaveCount(1);
    },
  );
});
