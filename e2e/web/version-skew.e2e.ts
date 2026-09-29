import { type Page } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { addLink, chooseRowMenuItem, linkRow } from './fixtures/links';
import { syncAndWait } from './fixtures/sync';

// docs/offline-mode.md, _version skew_: every tab on the origin opens the same two
// IndexedDB databases, and when a newer build opens one at a higher version the OLD
// tab has to let go at once — or the new tab's upgrade hangs (Dexie's database), or
// its auth never resolves (the raw session database). The "newer build" here is the
// same browser opening each database one version up from a second tab, which is
// exactly what a new build's first open does. The old tab must close without waiting
// for anyone, say so, and keep the unsaved editor on screen to copy from.
//
// Both cases take an isolated profile: the upgrade is permanent for the profile, and
// no other case may inherit a database this build can no longer open.

// Open `name` one version up, the way a newer build would. Resolves with the version
// it opened at, or rejects if the old tab's connection BLOCKED the upgrade.
function upgradeFrom(page: Page, name: string, nativeVersion: number): Promise<number> {
  return page.evaluate(
    ([db, version]) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open(db, version);
        const blocked = setTimeout(() => reject(new Error(`${db} upgrade blocked`)), 10_000);
        open.onblocked = () => undefined; // wait: the old tab should close promptly
        open.onerror = () => {
          clearTimeout(blocked);
          reject(open.error ?? new Error('open failed'));
        };
        open.onsuccess = () => {
          clearTimeout(blocked);
          const { version: opened } = open.result;
          open.result.close();
          resolve(opened);
        };
      }),
    [name, nativeVersion] as const,
  );
}

const banner = (page: Page) =>
  page.getByRole('alert').filter({ hasText: 'This tab can’t save changes anymore' });

test.describe('version skew', () => {
  test(
    'a newer build upgrading the data database closes the old tab’s connection at once, keeps its draft on screen, and offers the reload',
    { tag: ['@VERSION-SKEW-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, context } = app;
      const url = unresolvableUrl(unique('skew-kept'));
      const draft = unique('E2E unsaved title');

      await page.goto('/links');
      await addLink(page, url);
      await syncAndWait(page);
      await chooseRowMenuItem(page, url, 'Edit');
      const dialog = page.getByRole('dialog', { name: 'Edit link' });
      await dialog.getByRole('textbox', { name: 'Title' }).fill(draft);

      // Dexie's native version is `version(n) × 10`: 10 today, so a version(2) is 20.
      const newer = await context.newPage();
      await newer.goto('/sign-in');
      expect(await upgradeFrom(newer, 'bracemark-data', 20)).toBe(20);

      await expect(banner(page)).toBeVisible({ timeout: 10_000 });
      // The draft is still there to copy — nothing reloaded, nothing closed.
      await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue(draft);
      await expect(page.getByRole('button', { name: 'Reload' })).toBeVisible();

      // A tab of this build whose FIRST open comes after the upgrade never hears
      // `versionchange`. It is still signed in — a data-database failure is not a
      // session-store failure, so it gets the banner, not /sign-in.
      await newer.close();
      const late = await context.newPage();
      await late.goto('/links');
      await expect(banner(late)).toBeVisible({ timeout: 10_000 });
      await expect(late).toHaveURL(/\/links$/);
    },
  );

  test(
    'a newer build upgrading the session database is never blocked by an old tab',
    { tag: ['@VERSION-SKEW-WEB-002', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, context } = app;
      await page.goto('/links');
      const kept = unresolvableUrl(unique('session-skew-kept'));
      const draft = unique('session-skew-draft');
      await addLink(page, kept);
      await syncAndWait(page);
      await chooseRowMenuItem(page, kept, 'Edit');
      const dialog = page.getByRole('dialog', { name: 'Edit link' });
      await dialog.getByRole('textbox', { name: 'Title' }).fill(draft);

      // The raw session database never closes a connection on its own; without the
      // handler this open blocks until the old tab goes away.
      const newer = await context.newPage();
      await newer.goto('/sign-in');
      expect(await upgradeFrom(newer, 'bracemark-session', 2)).toBe(2);

      await expect(banner(page)).toBeVisible({ timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      // A session schema change must stop writes as well as sync scheduling.
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue(draft);
      await expect(linkRow(page, kept)).not.toContainText(draft);
    },
  );
});
