import { rm } from 'node:fs/promises';

import { expect, type Page, test, type TestInfo } from '@playwright/test';

import { profileDir } from '../paths';
import { createAccount, type Credentials, newCredentials } from '../web/fixtures/account';
import { unique, unresolvableUrl } from '../web/fixtures/data';
import { WEB_URL } from '../web/fixtures/env';
import { launchApp } from '../web/fixtures/launch';
import { addLink, chooseRowMenuItem, linkRow, openSidebarItem } from '../web/fixtures/links';
import { syncAndWait } from '../web/fixtures/sync';
import { type StaticOrigin, staticOrigin } from './fixtures/origin';
import { freshProfile, installAndRegister, openProfile, pwaRoot } from './fixtures/pwa';

// The PRODUCTION build of bracemark-web, as an installed app: the static export
// with its serwist service worker (`src/sw.ts`, precache + `defaultCache`),
// which the dev server never serves (`SerwistProvider disable` in development).
// The worker's routing is the library's; what only a real browser can show is
// that this build, this manifest and this worker together bring the app shell
// AND the local library back from a cold launch with nothing on the network —
// the origin refusing connections and the browser offline — and that a write
// made there reaches another client once the network returns.
//
// The build and its staging are the runner's (runner/pwa.ts); the origin is this
// spec's, because the case has to take it away. Installation proof in real
// browser chrome is PWA-RELEASE-001 (web/RELEASE.md).

interface InstalledApp {
  origin: StaticOrigin;
  profile: string;
  credentials: Credentials;
  // A link written and pushed during the online launch.
  kept: string;
}

// A fresh account in a fresh profile, installed, with its worker active, one
// link saved and synced — and then one more ONLINE launch, whose document the
// worker already serves. Closed on return: every case starts from a cold launch.
async function installedApp(label: string, testInfo: TestInfo): Promise<InstalledApp> {
  const origin = staticOrigin(pwaRoot(), WEB_URL);
  await origin.start();
  const profile = profileDir(`${label}-w${testInfo.workerIndex}`);
  await freshProfile(profile);
  const credentials = newCredentials();
  const kept = unresolvableUrl(unique(`${label}-kept`));

  const { context, page } = await openProfile(profile);
  try {
    await createAccount(page, credentials);
    await installAndRegister(page);
    await addLink(page, kept);
    await syncAndWait(page);
    const response = await page.goto('/links');
    expect(response?.fromServiceWorker()).toBe(true);
    await expect(linkRow(page, kept)).toBeVisible();
  } finally {
    await context.close();
  }
  return { origin, profile, credentials, kept };
}

async function checkpoint(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test.describe('pwa', () => {
  test(
    'a cold launch with the origin gone and the browser offline brings back the app shell and the library',
    { tag: ['@PWA-001', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(4 * 60 * 1000);
      const app = await installedApp('pwa-shell', testInfo);
      try {
        await app.origin.stop();
        const { context, page } = await openProfile(app.profile, { offline: true });
        try {
          const response = await page.goto('/links');
          // The document came from the worker: nothing else could have answered.
          expect(response?.fromServiceWorker()).toBe(true);
          await expect(linkRow(page, app.kept)).toBeVisible();
          // And the shell keeps working in place, not only on its first paint.
          await openSidebarItem(page, 'Show All');
          await expect(linkRow(page, app.kept)).toBeVisible();
          await checkpoint(page, testInfo, 'pwa-offline-cold-launch');
        } finally {
          await context.close();
        }
      } finally {
        await app.origin.stop();
        await rm(app.profile, { recursive: true, force: true });
      }
    },
  );

  test(
    'an edit made in the offline installed app syncs to an independent client once the network returns',
    { tag: ['@PWA-002', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(5 * 60 * 1000);
      const app = await installedApp('pwa-edit', testInfo);
      const added = unresolvableUrl(unique('pwa-added'));
      const title = unique('E2E pwa title');
      try {
        await app.origin.stop();
        const { context, page } = await openProfile(app.profile, { offline: true });
        try {
          const response = await page.goto('/links');
          expect(response?.fromServiceWorker()).toBe(true);
          await expect(linkRow(page, app.kept)).toBeVisible();

          // --- offline: one new link and one edit, both local and queued --------------
          await addLink(page, added);
          await chooseRowMenuItem(page, app.kept, 'Edit');
          const dialog = page.getByRole('dialog', { name: 'Edit link' });
          await dialog.getByRole('textbox', { name: 'Title' }).fill(title);
          await dialog.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(dialog).toHaveCount(0);
          await expect(linkRow(page, app.kept)).toContainText(title);
          await expect(
            page.getByRole('button', { name: 'More options (sync failed)' }),
          ).toBeVisible({ timeout: 60_000 });
          await checkpoint(page, testInfo, 'pwa-offline-edit-queued');

          // --- the network returns: origin and browser both ---------------------------
          await app.origin.start();
          await context.setOffline(false);
          await syncAndWait(page);
        } finally {
          await context.close();
        }

        const reader = await launchApp(profileDir(`pwa-reader-w${testInfo.workerIndex}`), {
          existing: app.credentials,
        });
        try {
          await reader.page.goto('/links');
          await syncAndWait(reader.page);
          await expect(linkRow(reader.page, added)).toHaveCount(1);
          await expect(linkRow(reader.page, app.kept)).toContainText(title);
        } finally {
          await reader.close();
        }
      } finally {
        await app.origin.stop();
        await rm(app.profile, { recursive: true, force: true });
      }
    },
  );
});
