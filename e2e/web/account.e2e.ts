import { profileDir } from '../paths';
import { expect, test } from './fixtures/app';
import { SITE_URL } from './fixtures/env';
import { launchApp } from './fixtures/launch';
import { addLinkButton } from './fixtures/links';

// Account creation itself is not a test in this file — every worker performs it in
// setup (fixtures/account.ts), so a failure there fails the whole run loudly and a
// dedicated spec would only pay the Argon2id cost a third time. What IS here is
// the two things account creation alone doesn't prove.
test.describe('account', () => {
  test('the session survives a reload', async ({ page }) => {
    // The point of the spec: the session is a non-extractable CryptoKey in
    // IndexedDB, and surviving a reload is the whole reason it lives there rather
    // than in memory (packages/web-react/src/data/session-store.ts). Nothing below
    // the browser can demonstrate this — jsdom's structured clone of a CryptoKey
    // is not the same object graph.
    await page.goto('/links');
    await page.reload();

    await expect(page).toHaveURL(/\/links/);
    // The add control only renders for an authenticated session, so its presence
    // after a reload is the signed-in assertion.
    await expect(addLinkButton(page)).toBeVisible();
  });

  // The empty pattern is required by Playwright, which parses this signature for
  // fixture dependencies and rejects a plain identifier — see fixtures/app.ts.
  // eslint-disable-next-line no-empty-pattern
  test('signing out leaves the app for the marketing site', async ({}, testInfo) => {
    // This one CANNOT use the shared worker fixture: signing out would strand
    // every other test in this worker on a dead session. It buys its own account
    // and its own profile, and pays a second Argon2id for the privilege.
    const app = await launchApp(profileDir(`signout-w${testInfo.workerIndex}`));

    try {
      const { page } = app;

      // Stub the marketing site. `npm run dev` is the app stack and deliberately
      // excludes bracemark-site (docs/env-files.md), so :3001 normally isn't
      // listening — and Playwright rejects the navigation with
      // ERR_CONNECTION_REFUSED under every `waitUntil`, including 'commit'.
      //
      // Fulfilling the request locally makes this spec independent of whether
      // `npm run dev:site` happens to be up, in either direction. Nothing is
      // faked that the spec asserts on: the claim is that bracemark-web sends the
      // browser to the site's ORIGIN, and what the site would have served is its
      // own concern, tested in its own project.
      const site = new URL(SITE_URL);
      await page.route(`${site.origin}/**`, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<title>site stub</title>' }),
      );

      await page.goto('/links');
      // The label gains a suffix in the sync-failed / storage-full states.
      await page.getByRole('button', { name: /^More options/ }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();

      // Sign-out is a cross-origin `location.replace` to bracemark-site, NOT a
      // route change — so assert on the ORIGIN the browser left for, not on any
      // bracemark-web URL. A spec that waited for a bracemark-web route here
      // would hang; one that asserted on the site's content would be testing the
      // wrong project.
      await page.waitForURL((url) => url.origin === site.origin, { timeout: 30_000 });
    } finally {
      await app.close();
    }
  });
});
