import { profileDir } from '../paths';
import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { launchApp } from './fixtures/launch';
import { addLink, chooseRowMenuItem, linkRow, openSidebarItem } from './fixtures/links';
import { syncAndWait } from './fixtures/sync';

// Local-first with the network gone, on a page that stays open: the library is
// read from IndexedDB, a new link and an edit are written there and queued, and
// the queue drains once the network is back — to a SECOND profile, since seeing
// a local write on the writer is not a sync claim. The engine's queue and
// reconcile are unit-tested; what only a browser shows is that the mounted app
// keeps working through `fetch` failing underneath it, says so, and recovers
// without a reload (docs/local-first-sync.md, _the three flows_).
//
// `context.setOffline` cuts the browser off at the network layer — every fetch
// fails as it would with the Wi-Fi off. The dev server has no service worker, so
// a reload or a hard navigation would fail too; that half is the PWA target's
// (pwa/pwa.e2e.ts).

test.describe('offline', () => {
  test(
    'an open page reads, writes and edits offline, then syncs the queue to another profile',
    { tag: ['@OFFLINE-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp }, testInfo) => {
      // Two Argon2id ceremonies and a failed cycle's retries.
      test.setTimeout(4 * 60 * 1000);
      const { context, page, credentials } = isolatedApp;
      const edited = unresolvableUrl(unique('offline-edited'));
      const kept = unresolvableUrl(unique('offline-kept'));
      const added = unresolvableUrl(unique('offline-added'));
      const title = unique('E2E offline title');

      await page.goto('/links');
      await addLink(page, kept);
      await addLink(page, edited);
      await syncAndWait(page);

      await context.setOffline(true);
      try {
        // --- read: the cached library, through in-app navigation --------------------
        await openSidebarItem(page, 'Show All');
        await expect(linkRow(page, kept)).toBeVisible();
        await openSidebarItem(page, 'My List');
        await expect(linkRow(page, edited)).toBeVisible();

        // --- write: a new link and an edit, both local ------------------------------
        await addLink(page, added);
        await chooseRowMenuItem(page, edited, 'Edit');
        const dialog = page.getByRole('dialog', { name: 'Edit link' });
        await dialog.getByRole('textbox', { name: 'Title' }).fill(title);
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(linkRow(page, edited)).toContainText(title);

        // The writes' own sync attempt failed, and the chrome says so rather than
        // spinning or saying nothing.
        await expect(page.getByRole('button', { name: 'More options (sync failed)' })).toBeVisible({
          timeout: 60_000,
        });
        await testInfo.attach('offline-web-queued', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      } finally {
        await context.setOffline(false);
      }

      // --- reconnect: the user's retry drains the queue ---------------------------------
      await syncAndWait(page);
      await expect(page.getByRole('button', { name: 'More options', exact: true })).toBeVisible();

      const reader = await launchApp(profileDir(`offline-reader-w${testInfo.workerIndex}`), {
        existing: credentials,
      });
      try {
        await reader.page.goto('/links');
        await syncAndWait(reader.page);
        await expect(linkRow(reader.page, added)).toHaveCount(1);
        await expect(linkRow(reader.page, edited)).toContainText(title);
        await expect(linkRow(reader.page, kept)).toHaveCount(1);
      } finally {
        await reader.close();
      }
    },
  );
});
