import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, type Page, test, type TestInfo } from '@playwright/test';

import { profileDir } from '../paths';
import { createAccount, type Credentials, newCredentials } from '../web/fixtures/account';
import { unique, unresolvableUrl } from '../web/fixtures/data';
import { WEB_URL } from '../web/fixtures/env';
import { exportPlainTextOffline } from '../web/fixtures/export';
import { launchApp } from '../web/fixtures/launch';
import {
  addLink,
  addLinkButton,
  chooseRowMenuItem,
  linkRow,
  openSidebarItem,
} from '../web/fixtures/links';
import { syncAndWait } from '../web/fixtures/sync';
import { type StaticOrigin, staticOrigin } from './fixtures/origin';
import {
  freshProfile,
  installAndRegister,
  openProfile,
  pwaRoot,
  restoreNetwork,
} from './fixtures/pwa';

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
async function installedApp(
  label: string,
  testInfo: TestInfo,
  root: string = pwaRoot(),
): Promise<InstalledApp> {
  const origin = staticOrigin(root, WEB_URL);
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
          await restoreNetwork(context);
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

  test(
    'the offline installed app reaches Settings in-app and exports its library, an offline write included',
    { tag: ['@PWA-003', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(4 * 60 * 1000);
      const app = await installedApp('pwa-export', testInfo);
      const added = unresolvableUrl(unique('pwa-export-added'));
      try {
        // Nothing answers: not the origin, not the api. This is the whole of
        // "the server is gone" as an installed user meets it.
        await app.origin.stop();
        const { context, page } = await openProfile(app.profile, { offline: true });
        try {
          // …and the device clock two years past the sign-in. The client this
          // replaced wiped itself once its clock passed the `expiresAt` it was
          // handed, server or no server — the timed delete docs/sessions.md is
          // built to rule out. There is no clock in the client now.
          await page.clock.setFixedTime(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000);
          const response = await page.goto('/links');
          expect(response?.fromServiceWorker()).toBe(true);
          await expect(linkRow(page, app.kept)).toBeVisible();
          await addLink(page, added);

          // The way a user gets there, not a typed URL: the menu, then the
          // section list. Each is a client route change whose payload only the
          // worker can supply now; a browser tab without one falls to Chrome's
          // error page on the first click (OFFLINE-EXPORT-WEB-001).
          await page.getByRole('button', { name: /^More options/ }).click();
          await page.getByRole('menuitem', { name: 'Settings' }).click();
          await page.getByRole('link', { name: 'Data', exact: true }).click();
          const text = await exportPlainTextOffline(page);
          expect(text).toContain(app.kept);
          expect(text).toContain(added);
          await checkpoint(page, testInfo, 'pwa-offline-export');
        } finally {
          await context.close();
        }
      } finally {
        await app.origin.stop();
        await rm(app.profile, { recursive: true, force: true });
      }
    },
  );
  // docs/offline-mode.md, _when the worker registers_: after sign-in, in ANY display
  // mode. No installAndRegister here — the app's own sign-in registers the worker in
  // a normal tab. And the case never opens Settings while online, so Settings →
  // Data can only come back from the precache, not from a runtime entry an online
  // visit left behind (PWA-003 can't tell the two apart).
  test(
    'a normal tab registers the worker after sign-in, and a cold offline launch reaches Settings and Data it never visited',
    { tag: ['@PWA-004', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(4 * 60 * 1000);
      const origin = staticOrigin(pwaRoot(), WEB_URL);
      await origin.start();
      const profile = profileDir(`pwa-tab-w${testInfo.workerIndex}`);
      await freshProfile(profile);
      const kept = unresolvableUrl(unique('pwa-tab-kept'));
      try {
        const online = await openProfile(profile);
        try {
          await createAccount(online.page, newCredentials());
          // Registered by the app itself, and installed (the precache downloaded).
          await online.page.evaluate(async () => {
            await navigator.serviceWorker.ready;
          });
          await expect
            .poll(() => online.page.evaluate(() => navigator.serviceWorker.controller !== null))
            .toBe(true);
          await addLink(online.page, kept);
          await syncAndWait(online.page);
          // Next's link prefetch warms whatever section links are on screen (Account,
          // Subscription); Data is the one the offline half needs cold.
          expect(
            await runtimeCacheUrls(online.page, (url) => url.pathname.startsWith('/settings/data')),
          ).toEqual([]);
        } finally {
          await online.context.close();
        }

        await origin.stop();
        const { context, page } = await openProfile(profile, { offline: true });
        try {
          const response = await page.goto('/links');
          expect(response?.fromServiceWorker()).toBe(true);
          await expect(linkRow(page, kept)).toBeVisible();
          await page.getByRole('button', { name: /^More options/ }).click();
          await page.getByRole('menuitem', { name: 'Settings' }).click();
          await page.getByRole('link', { name: 'Data', exact: true }).click();
          const text = await exportPlainTextOffline(page);
          expect(text).toContain(kept);
          await checkpoint(page, testInfo, 'pwa-tab-offline-export');
        } finally {
          await context.close();
        }
      } finally {
        await origin.stop();
        await rm(profile, { recursive: true, force: true });
      }
    },
  );

  // docs/offline-mode.md, _the worker caches the app, never data_: after a full
  // online session — sync, the entitlement read, a query-carrying view — no cache the
  // origin owns holds a cross-origin request. Every cache, not only the one
  // `defaultCache` names `cross-origin`. No runtime cache holds a query-keyed URL
  // either, before sign-out as well as after it: the precache ignores every query,
  // so `/links?list=<id>` — a full load or an in-app move — is answered from the
  // precache and never written to a runtime cache. The sign-out purge of such keys
  // is a safeguard; the pre-sign-out check is what fails if that ever changes. And
  // sign-out keeps the worker (the next sign-in stays reachable offline).
  test(
    'no cache holds a cross-origin or query-keyed response, and sign-out keeps the worker',
    { tag: ['@PWA-005', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(4 * 60 * 1000);
      const app = await installedApp('pwa-caches', testInfo);
      try {
        const { context, page } = await openProfile(app.profile);
        try {
          await page.goto('/links?sort=createdAt&order=asc');
          await expect(linkRow(page, app.kept)).toBeVisible();
          await syncAndWait(page);
          await page.goto('/settings/subscription');
          await page.goto('/links');
          await syncAndWait(page);

          const all = await runtimeCacheUrls(page, () => true, { includePrecache: true });
          expect(all.length).toBeGreaterThan(0);
          const origin = new URL(page.url()).origin;
          expect(all.filter((url) => new URL(url).origin !== origin)).toEqual([]);

          await openSidebarItem(page, 'Archive');
          await expect(page).toHaveURL(/\/links\?list=archive$/);
          expect(await runtimeCacheUrls(page, (url) => url.search !== '')).toEqual([]);

          await page.getByRole('button', { name: /^More options/ }).click();
          await page.getByRole('menuitem', { name: 'Sign out' }).click();
          await expect(page).not.toHaveURL(/\/links/, { timeout: 60_000 });
          await page.goto('/sign-in');
          expect(await runtimeCacheUrls(page, (url) => url.search !== '')).toEqual([]);
          expect(
            await page.evaluate(
              async () => (await navigator.serviceWorker.getRegistration()) != null,
            ),
          ).toBe(true);
        } finally {
          await context.close();
        }
      } finally {
        await app.origin.stop();
        await rm(app.profile, { recursive: true, force: true });
      }
    },
  );

  // docs/offline-mode.md, _navigations with a query string_: every route in the
  // static export is one file whatever its query, so a restored tab or a bookmark
  // at a query URL never visited that way online still opens with nothing on the
  // network (sw.ts, `ignoreURLParametersMatching`).
  test(
    'a cold offline load of a list URL never visited with that query comes from the worker',
    { tag: ['@PWA-006', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(4 * 60 * 1000);
      const app = await installedApp('pwa-query', testInfo);
      try {
        await app.origin.stop();
        const { context, page } = await openProfile(app.profile, { offline: true });
        try {
          const response = await page.goto(`/links?sort=createdAt&order=asc&q=${unique('never')}`);
          expect(response?.fromServiceWorker()).toBe(true);
          await expect(addLinkButton(page)).toBeVisible();
          await expect(linkRow(page, app.kept)).toBeVisible();
          await checkpoint(page, testInfo, 'pwa-query-cold-load');
        } finally {
          await context.close();
        }
      } finally {
        await app.origin.stop();
        await rm(app.profile, { recursive: true, force: true });
      }
    },
  );
  // docs/offline-mode.md, _update policy_: a new build's worker takes over at once
  // (`skipWaiting: true`). Build B here is build A with a changed worker script — a
  // new worker, the same precache — which is exactly the handover an open tab meets
  // after a deploy. Two tabs open on A: both get the pill (not before B has taken
  // over), the one left alone keeps working under B, and Reload lands the other on
  // B with the pill gone.
  test(
    'tabs open when a new worker takes over show the update pill, keep working, and reload into it',
    { tag: ['@PWA-007', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(4 * 60 * 1000);
      const root = await mkdtemp(join(tmpdir(), 'bracemark-pwa-b-'));
      await cp(pwaRoot(), root, { recursive: true });
      const app = await installedApp('pwa-update', testInfo, root);
      const added = unresolvableUrl(unique('pwa-update-added'));
      try {
        const { context, page } = await openProfile(app.profile);
        try {
          await page.goto('/links');
          await expect(linkRow(page, app.kept)).toBeVisible();
          const other = await context.newPage();
          await other.goto('/links');
          await expect(linkRow(other, app.kept)).toBeVisible();
          const pill = (p: Page) =>
            p.getByRole('status').filter({ hasText: 'Bracemark was updated' });
          await expect(pill(page)).toHaveCount(0);

          // Deploy B, and let the browser find it.
          await appendFile(join(root, 'sw.js'), `\n// build B ${Date.now()}\n`);
          await page.evaluate(async () => {
            await (await navigator.serviceWorker.getRegistration())?.update();
          });

          await expect(pill(page)).toBeVisible({ timeout: 60_000 });
          await expect(pill(other)).toBeVisible({ timeout: 30_000 });

          // The tab left alone keeps working under the new worker.
          await addLink(other, added);
          await expect(linkRow(other, added)).toBeVisible();

          await page.getByRole('button', { name: 'Reload' }).click();
          await page.waitForLoadState('load');
          await expect(linkRow(page, added)).toBeVisible({ timeout: 30_000 });
          await expect(pill(page)).toHaveCount(0);
          await checkpoint(page, testInfo, 'pwa-update-reloaded');
        } finally {
          await context.close();
        }
      } finally {
        await app.origin.stop();
        await rm(app.profile, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

// Every request URL held by the origin's caches that `keep` accepts — runtime caches
// only unless asked, since the precache's keys are the build's own files.
async function runtimeCacheUrls(
  page: Page,
  keep: (url: URL) => boolean,
  options: { includePrecache?: boolean } = {},
): Promise<string[]> {
  const urls = await page.evaluate(async (includePrecache) => {
    const out: string[] = [];
    for (const name of await caches.keys()) {
      if (!includePrecache && name.includes('precache')) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) out.push(request.url);
    }
    return out;
  }, options.includePrecache ?? false);
  return urls.filter((url) => keep(new URL(url)));
}
