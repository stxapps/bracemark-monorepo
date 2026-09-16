import { type Page } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { unique } from './fixtures/data';
import { SITE_URL } from './fixtures/env';
import { addLinkButton } from './fixtures/links';

// Both ways out of a session land on the marketing site's origin by a cross-origin
// `location.replace`. See the sign-out spec below for why it is stubbed.
async function stubMarketingSite(page: Page): Promise<URL> {
  const site = new URL(SITE_URL);
  await page.route(`${site.origin}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>site stub</title>' }),
  );
  return site;
}

// Account creation itself is not a test in this file — every worker performs it in
// setup (fixtures/account.ts), so a failure there fails the whole run loudly and a
// dedicated spec would only pay the Argon2id cost a third time. What IS here is
// the two things account creation alone doesn't prove.
test.describe('account', () => {
  test(
    'the session survives a reload',
    { tag: ['@WEB-ACCOUNT-001', '@smoke', '@online'] },
    async ({ page }) => {
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
    },
  );

  test(
    'signing out from a user list leaves the app for the marketing site',
    { tag: ['@WEB-ACCOUNT-002', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      // This one CANNOT use the shared worker fixture: signing out would strand
      // every other test in this worker on a dead session. It buys its own account
      // and its own profile, and pays a second Argon2id for the privilege.
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
      const site = await stubMarketingSite(page);

      // Sign out from a USER LIST, not from the bare /links this spec used to use.
      // That distinction is the whole regression: bare /links selects My List, a
      // SYSTEM list that readLists always merges in, so it can never look deleted.
      // A user list can — endSession's wipe takes it away, and if the app subtree
      // is still mounted when that lands, page-provider reads the `?list=` it is on
      // as a deleted entity and fires router.replace into AuthGuard's own exit. Two
      // navigators in one frame crashed the render and stranded the user, signed
      // out, on the page they were leaving. Measured, not assumed: against the
      // original cross-origin `redirect()` this spec fails, and the same spec on
      // bare /links passes. What it pins is that half — the `location.replace`
      // exit — and it needs a real router plus a real IndexedDB wipe to do it.
      // The teardown's other half (auth-provider's 'ending', which unmounts before
      // the wipe) is deliberately NOT covered here: with location.replace in place
      // the stray dispatch is absorbed, so nothing observable breaks without it.
      // See docs/data-lifecycle.md, "the sign-out teardown".
      const list = unique('E2e signout list');
      await page.goto('/settings/lists');
      const create = page.getByLabel('New list name');
      await create.fill(list);
      await create.press('Enter');
      await expect(page.locator(`input[aria-label="List name"][value="${list}"]`)).toBeVisible();

      await page.goto('/links');
      await page.getByRole('button', { name: list }).click();
      // The selection has to be in the URL before signing out — that param IS what
      // page-provider would misread. Asserting it makes a future sidebar change
      // that stops writing `?list=` fail here loudly instead of quietly gutting
      // this spec back into the bare-/links case it replaced.
      await expect(page).toHaveURL(/[?&]list=/);

      // The label gains a suffix in the sync-failed / storage-full states.
      await page.getByRole('button', { name: /^More options/ }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();

      // Sign-out is a cross-origin `location.replace` to bracemark-site, NOT a
      // route change — so assert on the ORIGIN the browser left for, not on any
      // bracemark-web URL. A spec that waited for a bracemark-web route here
      // would hang; one that asserted on the site's content would be testing the
      // wrong project.
      await page.waitForURL((url) => url.origin === site.origin, { timeout: 30_000 });
    },
  );

  test(
    'deleting the account ends the session and refuses a later sign-in',
    { tag: ['@ACCOUNT-DELETE-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      // Destructive by definition, so it owns its account and profile. What the
      // api's own spec cannot reach is the client half: the password re-entry
      // derives the key in a real browser and signs the delete-account proof,
      // and the local teardown then has to take the IndexedDB session with it.
      // The server's deletion matrix (tombstone, doors, the subscription gate,
      // every session revoked) stays in apps/bracemark-api/src/routes/auth.spec.ts.
      const { page, credentials } = app;
      const site = await stubMarketingSite(page);

      await page.goto('/settings/account');
      await page.getByRole('button', { name: /^Delete account/ }).click();

      // By id, as in fixtures/account.ts: the password wrapper's "Show password"
      // toggle also matches the field's label.
      await page.locator('#delete-account-password').fill(credentials.password);
      await page.locator('#delete-account-confirm').check();
      await page.getByRole('button', { name: 'Delete account forever' }).click();

      // Argon2id runs before the POST, so this waits out a derivation.
      await page.waitForURL((url) => url.origin === site.origin, { timeout: 60_000 });

      // The session has to be gone from the PROFILE, not just from the page that
      // left. A fresh load of a protected route with no stored session is a
      // direct visit, which AuthGuard answers with /sign-in rather than the app.
      await page.goto('/links');
      await expect(page).toHaveURL(/\/sign-in/);
      await expect(addLinkButton(page)).not.toBeVisible();

      await page.locator('#username').fill(credentials.username);
      await page.locator('#password').fill(credentials.password);
      await page.getByRole('button', { name: /^Sign in$/ }).click();

      // The message is asserted because it is the only thing that tells a refusal
      // from an outage: an unreachable api raises an alert in the same place with
      // "Could not sign in". A deleted username answers exactly like one that never
      // existed (docs/data-lifecycle.md, _delete account_).
      // Scoped to the form: Next's route announcer is also a role="alert".
      await expect(page.locator('form').getByRole('alert')).toHaveText(
        /Incorrect username or password/,
      );
      await expect(page).toHaveURL(/\/sign-in/);
    },
  );
});
