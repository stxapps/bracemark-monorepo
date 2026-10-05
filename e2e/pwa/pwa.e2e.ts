import { rm } from 'node:fs/promises';

import { expect, type Page, type Response, test, type TestInfo } from '@playwright/test';

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
import {
  controllingBuild,
  deployBuild,
  precachedRevisions,
  requestUpdateCheck,
  stageCopy,
} from './fixtures/build';
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

// How long PWA-012 lets a launch against a stalled origin run before giving up.
// Long on purpose: when the worker's timeout is missing this is what measures how
// long the browser waits by itself, instead of failing at a default 30 s.
const STALLED_LAUNCH_BUDGET_MS = 5 * 60 * 1000;

// The "updated, reload" pill (components/update-pill.tsx).
const pill = (page: Page) => page.getByRole('status').filter({ hasText: 'Bracemark was updated' });

// The document a navigation was handed, which must have come from the worker.
async function servedDocument(response: Response | null): Promise<string> {
  expect(response?.fromServiceWorker()).toBe(true);
  return (await response?.text()) ?? '';
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
  // (`skipWaiting: true`). Two tabs open on build A when build B is deployed
  // (fixtures/build.ts): both get the pill — not before B has taken over, and
  // because B is ANOTHER build than the one they loaded as — the one left alone
  // keeps working under B, and Reload lands the other on B with the pill gone.
  test(
    'tabs open when a new worker takes over show the update pill, keep working, and reload into it',
    { tag: ['@PWA-007', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(4 * 60 * 1000);
      const root = await stageCopy();
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
          await expect(pill(page)).toHaveCount(0);

          // Deploy B, and let the browser find it.
          const b = await deployBuild(root, 'B');
          await requestUpdateCheck(page);

          await expect(pill(page)).toBeVisible({ timeout: 60_000 });
          await expect(pill(other)).toBeVisible({ timeout: 30_000 });

          // The tab left alone keeps working under the new worker.
          await addLink(other, added);
          await expect(linkRow(other, added)).toBeVisible();

          await page.getByRole('button', { name: 'Reload' }).click();
          await page.waitForLoadState('load');
          await expect(linkRow(page, added)).toBeVisible({ timeout: 30_000 });
          expect(await controllingBuild(page)).toBe(b.id);
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

  // The four update cases below share one rule (fixtures/build.ts): the worker
  // answers a navigation with the NETWORK's copy whenever the origin is reachable
  // (the navigation listener, sw.ts), so a document only says which build the WORKER
  // holds once the origin is stopped. Each case stops it before reading that.

  // docs/offline-mode.md, _`/sw.js` is permanent_, the third way to strand a
  // device: a worker that installs and activates perfectly and still holds the OLD
  // page. PWA-007's build B has A's precache, so it cannot tell. Here B changes a
  // page and adds an asset, and the origin is stopped before the reload — so the
  // document and the asset can only be B's own precache, and a page whose
  // revision had not moved would come back as A's.
  test(
    'a new build replaces a changed page and adds its new asset in the precache, and a reload with the origin gone gets both',
    { tag: ['@PWA-008', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(4 * 60 * 1000);
      const root = await stageCopy();
      const app = await installedApp('pwa-content', testInfo, root);
      try {
        const { context, page } = await openProfile(app.profile);
        try {
          await page.goto('/links');
          await expect(linkRow(page, app.kept)).toBeVisible();

          const b = await deployBuild(root, 'B');
          await requestUpdateCheck(page);
          // A's copy of the page is deleted, not merely outranked.
          await expect
            .poll(() => precachedRevisions(page, '/links'), { timeout: 60_000 })
            .toEqual([b.revision]);
          await expect(pill(page)).toBeVisible();

          await app.origin.stop();
          expect(await servedDocument(await page.reload())).toContain(b.marker);
          await expect(linkRow(page, app.kept)).toBeVisible();
          expect(await page.evaluate(async (url) => (await fetch(url)).text(), b.asset)).toContain(
            'e2e build B',
          );
          await checkpoint(page, testInfo, 'pwa-update-new-content');
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

  // The path a real user takes, which PWA-007 and PWA-008 skip by asking for a
  // check: the app is closed, a deploy happens, the app is opened. Nothing in the
  // case asks for anything. The launch is ALREADY build B's page — the old worker
  // hands over the network's copy — and the check the browser makes by itself
  // after that navigation installs B's worker, which a second launch with the
  // origin gone proves: only B's precache can answer it.
  //
  // And NO PILL on that launch. B's worker taking over a page that is already B
  // is the worker catching up, not an update of the page; before the pill compared
  // builds this was every user's first launch after every deploy, asking for a
  // reload that changed nothing (PWA-007 and PWA-008 are the pill that SHOULD show).
  test(
    'a cold launch after a deploy gets the new page at once and the new worker without being asked, and the next launch with the origin gone is the new build',
    { tag: ['@PWA-009', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(5 * 60 * 1000);
      const root = await stageCopy();
      const app = await installedApp('pwa-relaunch', testInfo, root);
      try {
        const b = await deployBuild(root, 'B');

        const first = await openProfile(app.profile);
        try {
          expect(await servedDocument(await first.page.goto('/links'))).toContain(b.marker);
          await expect(linkRow(first.page, app.kept)).toBeVisible();
          await expect
            .poll(() => precachedRevisions(first.page, '/links'), { timeout: 90_000 })
            .toEqual([b.revision]);
          // B's worker is in control of this page, so the pill has had its answer.
          await expect.poll(() => controllingBuild(first.page)).toBe(b.id);
          await checkpoint(first.page, testInfo, 'pwa-relaunch-new-worker');
          await expect(pill(first.page)).toHaveCount(0);
        } finally {
          await first.context.close();
        }

        await app.origin.stop();
        const second = await openProfile(app.profile);
        try {
          expect(await servedDocument(await second.page.goto('/links'))).toContain(b.marker);
          await expect(linkRow(second.page, app.kept)).toBeVisible();
        } finally {
          await second.context.close();
        }
      } finally {
        await app.origin.stop();
        await rm(app.profile, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  // docs/offline-mode.md, _`/sw.js` is permanent_, the second way: the precache
  // install is all-or-nothing, so ONE manifest URL the origin answers 404 means
  // the new worker never takes over. What that leaves has to be harmless — the old
  // worker still in control, its build still what the device opens with the origin
  // gone, writes still landing, no pill (PWA-008 is the pill that shows) — and
  // recoverable by nothing more than a
  // deploy: build C, with the entry gone, takes over and clears what the failed
  // install left behind.
  //
  // ⚠ C is met on a RELAUNCH, not in the same window, and that is not a shortcut.
  // In the Serwist this repo ships a failed precache fetch does not fail the
  // install, it HANGS it (docs/offline-mode.md, _a failed install hangs_): the new
  // worker sits in `installing` for five minutes, and a check made meanwhile is
  // merged into the stuck one and installs nothing. Closing the browser discards
  // the stuck worker. The case does not assert the hang — an upstream fix must not
  // turn it red.
  test(
    'a build whose precache names a missing file never takes over and leaves the old build working, and the fixed build after it takes over on the next launch',
    { tag: ['@PWA-010', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(5 * 60 * 1000);
      const root = await stageCopy();
      const app = await installedApp('pwa-failed-install', testInfo, root);
      const added = unresolvableUrl(unique('pwa-failed-install-added'));
      try {
        const first = await openProfile(app.profile);
        try {
          const { page } = first;
          await page.goto('/links');
          await expect(linkRow(page, app.kept)).toBeVisible();
          const [a] = await precachedRevisions(page, '/links');

          const bad = await deployBuild(root, 'B', { missingPrecacheEntry: true });
          await requestUpdateCheck(page);
          // The install ran, and met the file it was built to miss.
          await expect
            .poll(() => app.origin.answered(bad.missing), { timeout: 60_000 })
            .toContain(404);

          // Build A, untouched: still in the precache, no pill, and with the
          // origin gone it is A's page that opens and A's app that takes a write.
          expect(await precachedRevisions(page, '/links')).toContain(a);
          await app.origin.stop();
          expect(await servedDocument(await page.reload())).not.toContain(bad.marker);
          await expect(linkRow(page, app.kept)).toBeVisible();
          await addLink(page, added);
          await expect(pill(page)).toHaveCount(0);
          await checkpoint(page, testInfo, 'pwa-failed-install-still-working');
        } finally {
          await first.context.close();
        }

        await app.origin.start();
        const fixed = await deployBuild(root, 'C');
        const { context, page } = await openProfile(app.profile);
        try {
          await page.goto('/links');
          // Only C's page is left — not A's, not the one the failed install fetched.
          await expect
            .poll(() => precachedRevisions(page, '/links'), { timeout: 90_000 })
            .toEqual([fixed.revision]);
          await app.origin.stop();
          expect(await servedDocument(await page.reload())).toContain(fixed.marker);
          await expect(linkRow(page, added)).toBeVisible();
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

  // The claim the whole update design rests on: replacing a build needs NOTHING
  // from the page. Build B's `/links` ships without a single script — no
  // registration call, no update check, no pill, no error boundary. A launch after
  // that deploy shows the dead page, and the browser installs B's worker anyway,
  // on its own check: the device now HOLDS the broken build (proven with the
  // origin stopped). Then the fix, C, is deployed, and one reload is the app
  // again, library intact, with C's worker following by itself. If an update ever
  // comes to depend on app code — a check only the app triggers, a takeover only
  // the pill completes — this is the case that goes red.
  test(
    'a build whose page runs no script at all is installed and then replaced on the browser’s own check, and one reload after the fix brings the app and its library back',
    { tag: ['@PWA-011', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(5 * 60 * 1000);
      const root = await stageCopy();
      const app = await installedApp('pwa-broken-build', testInfo, root);
      try {
        const broken = await deployBuild(root, 'B', { document: 'no-scripts' });
        const { context, page } = await openProfile(app.profile);
        try {
          // --- the broken build ships: nothing on the page can ask for anything ---
          expect(await servedDocument(await page.goto('/links'))).toContain(broken.marker);
          expect(await page.evaluate(() => document.scripts.length)).toBe(0);
          await expect
            .poll(() => precachedRevisions(page, '/links'), { timeout: 90_000 })
            .toEqual([broken.revision]);
          await app.origin.stop();
          expect(await servedDocument(await page.reload())).toContain(broken.marker);
          expect(await page.evaluate(() => document.scripts.length)).toBe(0);
          await expect(linkRow(page, app.kept)).toHaveCount(0);
          await checkpoint(page, testInfo, 'pwa-broken-build');
          await app.origin.start();

          // --- the fix ships: one reload, with the broken worker still in control --
          const fixed = await deployBuild(root, 'C');
          expect(await servedDocument(await page.reload())).toContain(fixed.marker);
          await expect(linkRow(page, app.kept)).toBeVisible();
          await expect
            .poll(() => precachedRevisions(page, '/links'), { timeout: 90_000 })
            .toEqual([fixed.revision]);
          await app.origin.stop();
          expect(await servedDocument(await page.reload())).toContain(fixed.marker);
          await expect(linkRow(page, app.kept)).toBeVisible();
          await checkpoint(page, testInfo, 'pwa-broken-build-recovered');
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

  // docs/offline-mode.md, _what answers a navigation_: the network goes first, but
  // only for a few seconds. `stop()` — a refused connection — cannot show this: a
  // refusal fails at once, so every other offline case here opens instantly with
  // or without a timeout. A STALLED origin accepts the connection and never
  // answers, and without the timeout the launch waits on it in front of a blank
  // window while the whole app sits in the precache.
  test(
    'with the origin accepting connections and never answering, a launch opens the installed build from the precache within seconds',
    { tag: ['@PWA-012', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(6 * 60 * 1000);
      const app = await installedApp('pwa-stalled', testInfo);
      try {
        app.origin.respond('stall');
        const { context, page } = await openProfile(app.profile);
        try {
          const started = Date.now();
          const response = await page.goto('/links', { timeout: STALLED_LAUNCH_BUDGET_MS });
          const opened = Date.now() - started;
          expect(response?.fromServiceWorker()).toBe(true);
          await expect(linkRow(page, app.kept)).toBeVisible();
          await testInfo.attach('stalled-launch-ms', { body: String(opened) });
          // The worker's timeout is 3 s (lib/navigation-response.ts); the rest is
          // the launch itself.
          expect(opened).toBeLessThan(10_000);
          // And the app works in place: an in-app move needs no page load.
          await openSidebarItem(page, 'Show All');
          await expect(linkRow(page, app.kept)).toBeVisible();
          await checkpoint(page, testInfo, 'pwa-stalled-origin-launch');
        } finally {
          await context.close();
        }
      } finally {
        await app.origin.stop();
        await rm(app.profile, { recursive: true, force: true });
      }
    },
  );

  // The other two answers the origin can give a page load. A SERVER ERROR is the
  // origin being broken, and no reason to withhold a page the device holds: the
  // precache answers. A 404 is the origin saying the page is not there, and it
  // stands — the worker must not turn every unknown path into the app.
  test(
    'an origin answering 500 opens the installed build from the precache, and an unknown path still gets the origin’s 404',
    { tag: ['@PWA-013', '@full', '@online', '@pwa'] },
    // eslint-disable-next-line no-empty-pattern
    async ({}, testInfo) => {
      test.setTimeout(4 * 60 * 1000);
      const app = await installedApp('pwa-origin-error', testInfo);
      try {
        const { context, page } = await openProfile(app.profile);
        try {
          app.origin.respond(500);
          const response = await page.goto('/links');
          expect(response?.fromServiceWorker()).toBe(true);
          expect(response?.status()).toBe(200);
          await expect(linkRow(page, app.kept)).toBeVisible();
          expect(app.origin.answered('/links')).toContain(500);
          await checkpoint(page, testInfo, 'pwa-origin-500');

          app.origin.respond('serve');
          const missing = await page.goto('/e2e-no-such-page');
          expect(missing?.fromServiceWorker()).toBe(true);
          expect(missing?.status()).toBe(404);
        } finally {
          await context.close();
        }
      } finally {
        await app.origin.stop();
        await rm(app.profile, { recursive: true, force: true });
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
