import { rm } from 'node:fs/promises';

import { profileDir } from '../paths';
import { deleteAllData, importArchive } from '../seed/steps';
import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { writeHeavyLibrary } from './fixtures/heavy-library';
import { launchApp } from './fixtures/launch';
import { addLink, displayUrl, linkRow } from './fixtures/links';
import { syncAndWait } from './fixtures/sync';

// The server's storage ceiling as a client meets it. The gate itself, and the
// engine turning its 403 into a completed-but-blocked cycle, are unit-tested
// (lib/quota.ts, both engines' signPushable); what only the whole stack shows is
// a REAL refusal — bytes a client encrypted and uploaded until the account was
// full — reported as storage full rather than as a sync that failed.
//
// This file runs in its own Playwright project, after every other web spec and
// alone (playwright.config.ts). It pushes and then wipes 110 MiB through the one
// local api and R2, and a spec sharing the stack with it meanwhile timed out on
// its own sync and delete-all receipts (docs/e2e.md, _cross-client sync_).
test.describe('capacity', () => {
  test(
    'a push the storage ceiling refuses is reported as storage full, not as a failed sync',
    { tag: ['@SYNC-BLOCKED-001', '@full', '@online', '@destructive', '@scale'] },
    async ({ isolatedApp: app }, testInfo) => {
      // Real bytes to a real ceiling: eleven 10 MiB previews against the free
      // plan's 100 MiB. Encrypting, uploading and then wiping them is the slow part.
      test.setTimeout(10 * 60 * 1000);
      const { page } = app;

      // A link that reaches the server first, so the independent reader below
      // has something to prove its pull finished on.
      const anchor = unresolvableUrl(unique('before-the-ceiling'));
      await page.goto('/links');
      await addLink(page, anchor);
      await syncAndWait(page);

      const library = await writeHeavyLibrary(testInfo.outputPath('heavy.zip'), {
        count: 11,
        fileBytes: 10 * 1024 * 1024,
        label: unique('heavy').toLowerCase(),
      });
      await importArchive(page, library.archivePath);
      // 110 MiB that has done its job; the retained test output needs none of it.
      await rm(library.archivePath);

      // The import's own push is the refused one: its files fill the account, and
      // the links and extractions queued behind them hit the gate. It writes one
      // entity at a time and every write kicks a cycle, so an early cycle can
      // already report the refusal while later files are still queued; one full
      // Sync drains them before anything is read.
      await page.goto('/links');
      await syncAndWait(page, 5 * 60 * 1000);

      // --- the Data card explains it -----------------------------------------------------
      await page.goto('/settings/data');
      const explained = page.getByText(/can’t sync because your storage is full/);
      const failed = page.getByText('Sync failed');
      // Either settled reading ends the wait, so the regression this case exists
      // for fails in seconds rather than at the timeout.
      await expect(explained.or(failed)).toBeVisible({ timeout: 60_000 });
      await expect(failed).toHaveCount(0);
      await expect(explained).toBeVisible();
      await expect(page.getByText(/\d+ changes? waiting to sync/)).toBeVisible();

      // --- the links page reports it, and a retry does not turn it into an error ----------
      await page.goto('/links');
      const trigger = page.getByRole('button', { name: /^More options/ });
      await expect(trigger).toHaveAccessibleName('More options (storage full)');
      await syncAndWait(page);
      await expect(trigger).toHaveAccessibleName('More options (storage full)');
      await trigger.click();
      await expect(page.getByRole('menuitem', { name: /^Storage full/ })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: /Sync failed/ })).toHaveCount(0);
      await page.keyboard.press('Escape');

      // --- and the refusal is the server's: an independent client never sees them --------
      const reader = await launchApp(profileDir(`blocked-reader-w${testInfo.workerIndex}`), {
        existing: app.credentials,
      });
      try {
        await reader.page.goto('/links');
        await expect(reader.page.getByText(displayUrl(anchor))).toBeVisible({ timeout: 60_000 });
        for (const url of library.urls) {
          await expect(linkRow(reader.page, url)).toHaveCount(0);
        }
      } finally {
        await reader.close();
      }

      // Give the local R2 its 110 MiB back; nothing else would.
      await deleteAllData(page);
    },
  );
});
