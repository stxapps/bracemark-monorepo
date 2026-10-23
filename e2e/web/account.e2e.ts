import { type Page } from '@playwright/test';

import { profileDir } from '../paths';
import { IS_STAGING } from '../runner/environment';
import { createAccount, type Credentials, newCredentials, signIn } from './fixtures/account';
import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { API_URL, SITE_URL } from './fixtures/env';
import { launchApp } from './fixtures/launch';
import { addLink, addLinkButton, linkRow } from './fixtures/links';
import { countPendingOps, syncAndWait } from './fixtures/sync';

// Both ways out of a session land on the marketing site's origin by a cross-origin
// `location.replace`. See the sign-out spec below for why it is stubbed.
async function stubMarketingSite(page: Page): Promise<URL> {
  const site = new URL(SITE_URL);
  if (IS_STAGING) return site;
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
      const { page, credentials } = app;

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

      await syncAndWait(page);
      await page.route('**/v1/ops/**', (route) => route.abort());
      const queued = unresolvableUrl(unique('signout-queued'));
      await addLink(page, queued);
      expect(await countPendingOps(page)).toBeGreaterThan(0);
      await page.getByRole('button', { name: /^More options/ }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
      // The flow syncs before it asks (docs/data-lifecycle.md, _the press, and the
      // wait_), so the question is not there at the click: it replaces the sync's
      // wait once that cycle has given up on the aborted route, which the retry
      // policy takes up to nine seconds over, or at the flow's own 15 s bound.
      const warning = page.getByTestId('sign-out-dialog');
      await expect(warning).toContainText('nowhere else', { timeout: 30_000 });
      await warning.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(warning).toHaveCount(0);
      await expect(linkRow(page, queued)).toBeVisible();
      expect(await countPendingOps(page)).toBeGreaterThan(0);
      await page.unroute('**/v1/ops/**');

      // Sign out again with the queue STILL pending, and no sync of our own in
      // between: the flow's cycle is what pushes it now that the route is back,
      // and an emptied queue signs out with no question. Were the sync skipped,
      // the dialog would ask again and the wait below would time out.
      // The label gains a suffix in the sync-failed / storage-full states.
      await page.getByRole('button', { name: /^More options/ }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();

      // Sign-out is a cross-origin `location.replace` to bracemark-site, NOT a
      // route change — so assert on the ORIGIN the browser left for, not on any
      // bracemark-web URL. A spec that waited for a bracemark-web route here
      // would hang; one that asserted on the site's content would be testing the
      // wrong project.
      await page.waitForURL((url) => url.origin === site.origin, { timeout: 30_000 });
      // The wipe must be recoverable from the server, including the edit that
      // only this sign-out's sync could push.
      await signIn(page, credentials);
      await expect(page.getByRole('button', { name: list })).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: list }).click();
      await expect(linkRow(page, queued)).toBeVisible();
    },
  );

  test(
    'cancelling a sync wait stays cancelled after its timeout and late completion',
    { tag: ['@SIGN-OUT-CANCEL-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page } = app;
      await page.goto('/links');
      await syncAndWait(page);
      const queued = unresolvableUrl(unique('signout-cancel'));
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/v1/ops/**', async (route) => {
        await held;
        await route.continue();
      });
      let signOutRequests = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/v1/auth/sign-out') signOutRequests += 1;
      });
      try {
        await addLink(page, queued);
        expect(await countPendingOps(page)).toBeGreaterThan(0);
        await requestSignOut(page);
        const dialog = page.getByTestId('sign-out-dialog');
        await expect(dialog).toContainText('Syncing before signing out');
        await expect(dialog.getByTestId('sign-out-confirm')).toHaveCount(0);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(dialog).toHaveCount(0);

        // Restart while the original cycle still waits. Only this second flow
        // may replace the spinner with a question when its bounded wait ends.
        await requestSignOut(page);
        await expect(dialog).toContainText('nowhere else', { timeout: 30_000 });
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        release();
        await expect.poll(() => countPendingOps(page), { timeout: 60_000 }).toBe(0);
        await expect(dialog).toHaveCount(0);
        await expect(linkRow(page, queued)).toBeVisible();
        expect(signOutRequests).toBe(0);
        await page.reload();
        await expect(linkRow(page, queued)).toBeVisible();
      } finally {
        release();
      }
    },
  );

  test(
    'a sign-out warning cannot revoke a session resumed in another tab',
    { tag: ['@SIGN-OUT-RESUME-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, context, credentials } = app;
      await page.goto('/links');
      await syncAndWait(page);
      await forgeStoredToken(page, `unknown-${unique('signout-resume')}`);
      await page.reload();
      await expect(pausedNotice(page)).toBeVisible({ timeout: 60_000 });
      const other = await context.newPage();
      await other.goto('/links');
      await expect(pausedNotice(other)).toBeVisible();
      const queued = unresolvableUrl(unique('signout-resume-queued'));
      await addLink(page, queued);
      await requestSignOut(page);
      const dialog = page.getByTestId('sign-out-dialog');
      await expect(dialog).toContainText('nowhere else');
      let signOutRequests = 0;
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/v1/auth/sign-out') signOutRequests += 1;
      });

      await other.getByRole('button', { name: 'Sign in to resume' }).click();
      const resume = other.getByRole('dialog', { name: 'Sign in to resume' });
      await resume.locator('#password').fill(credentials.password);
      await resume.getByRole('button', { name: /^Sign in$/ }).click();
      await expect(resume).toHaveCount(0, { timeout: 60_000 });
      await expect(pausedNotice(other)).toHaveCount(0);
      await expect(pausedNotice(page)).toHaveCount(0);
      // The replacement owns a new edit that has not reached the server.
      // A stale confirmation must not erase it with the replacement session.
      await context.route('**/v1/ops/**', (route) => route.abort());
      const replacementQueued = unresolvableUrl(unique('resumed-unsynced'));
      await addLink(other, replacementQueued);
      expect(await countPendingOps(other)).toBeGreaterThan(0);
      await dialog.getByTestId('sign-out-confirm').click();
      await expect(dialog).toHaveCount(0);
      await expect(addLinkButton(page)).toBeEnabled();
      expect(signOutRequests).toBe(0);
      await page.reload();
      await expect(linkRow(page, queued)).toBeVisible();
      await expect(linkRow(page, replacementQueued)).toBeVisible();
      expect(await countPendingOps(page)).toBeGreaterThan(0);
      await context.unroute('**/v1/ops/**');

      // The old flow also releases its latch: a fresh sign-out still works.
      const site = await stubMarketingSite(page);
      await syncAndWait(page);
      await signOutToSite(page, site);
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

  test(
    'a session the server revokes wipes this device and lands on sign-in, and signing back in restores the library',
    { tag: ['@SESSION-INVALID-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }, testInfo) => {
      // Three Argon2id ceremonies: the account, the revoking profile, the return.
      test.setTimeout(4 * 60 * 1000);
      const { page, credentials } = app;
      const kept = unresolvableUrl(unique('revoked-kept'));

      await page.goto('/links');
      await addLink(page, kept);
      await syncAndWait(page);
      expect(await countSyncedItems(page)).toBeGreaterThan(0);

      // Revoked the way a user revokes it, from another device: no test hook,
      // and the api's own answer to this token from now on is a real 401.
      const other = await launchApp(profileDir(`revoker-w${testInfo.workerIndex}`), {
        existing: credentials,
      });
      try {
        await other.page.goto('/settings/account');
        await other.page.getByRole('button', { name: /^Sign out other devices/ }).click();
        await other.page
          .getByRole('button', { name: 'Sign out other devices', exact: true })
          .click();
        await expect(
          other.page.getByText(/^Your other devices have been signed out\./),
        ).toBeVisible();
      } finally {
        await other.close();
      }

      // The page is still open and still believes it is signed in; its next
      // request is the one that learns otherwise. Sync is the user's own trigger.
      await page.getByRole('button', { name: /^More options/ }).click();
      await page.getByRole('menuitem', { name: /^(Sync|Sync failed)/ }).click();

      // A revoked session is not a sign-out: it stays on this origin and keeps
      // where the user was, for sign-in to return them there (auth-guard.tsx) —
      // unlike WEB-ACCOUNT-002's exit to the marketing site — and it says why the
      // library is gone.
      await expect(page).toHaveURL(/\/sign-in\?next=%2Flinks/, { timeout: 60_000 });
      await expect(page.getByRole('status')).toHaveText(/signed out from another device/);
      // The local store held DECRYPTED bookmarks; the teardown must take them
      // with the session (docs/data-lifecycle.md, _the sign-out teardown_).
      expect(await countSyncedItems(page)).toBe(0);
      await page.goto('/links');
      await expect(page).toHaveURL(/\/sign-in/);

      // Only this device's copy went: the account's library is still on the
      // server and comes back with a fresh session.
      await page.locator('#username').fill(credentials.username);
      await page.locator('#password').fill(credentials.password);
      await page.getByRole('button', { name: /^Sign in$/ }).click();
      await expect(page).toHaveURL(/\/links/, { timeout: 60_000 });
      await expect(linkRow(page, kept)).toBeVisible({ timeout: 30_000 });
    },
  );

  // docs/sessions.md: an EXPIRED session keeps everything. Expired the way a user
  // expires it — changing the password on another device, which cuts every other
  // session off WITHOUT telling it to forget. The page learns it on its next
  // request, pauses sync, keeps the library open and editable in every tab, and a
  // sign-in with the new password resumes it and pushes what queued meanwhile.
  test(
    'an expired session keeps the library and a queued edit in every tab, and resumes with the new password',
    { tag: ['@SESSION-EXPIRED-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }, testInfo) => {
      // Three Argon2id ceremonies (the account, the password change, the resume)
      // plus a reader's sign-in.
      test.setTimeout(5 * 60 * 1000);
      const { page, context, credentials } = app;
      const kept = unresolvableUrl(unique('expired-kept'));
      const queued = unresolvableUrl(unique('expired-queued'));

      await page.goto('/links');
      await addLink(page, kept);
      await syncAndWait(page);
      const other = await context.newPage();
      await other.goto('/links');
      await expect(linkRow(other, kept)).toBeVisible();

      const newPassword = newCredentials().password;
      await changePasswordElsewhere(
        profileDir(`expirer-w${testInfo.workerIndex}`),
        credentials,
        newPassword,
      );

      // The next request learns it — the user's own Sync.
      await page.getByRole('button', { name: /^More options/ }).click();
      await page.getByRole('menuitem', { name: /^(Sync|Sync failed)/ }).click();
      await page.keyboard.press('Escape');
      await expect(pausedNotice(page)).toBeVisible({ timeout: 60_000 });
      // Nothing left the app, nothing was wiped.
      await expect(page).toHaveURL(/\/links/);
      await expect(linkRow(page, kept)).toBeVisible();
      // The other tab hears it through the session channel, not its own request.
      await expect(pausedNotice(other)).toBeVisible({ timeout: 30_000 });

      // Edits still work while paused, and wait in the queue.
      await addLink(page, queued);
      await expect(linkRow(page, queued)).toBeVisible();
      expect(await countPendingOps(page)).toBeGreaterThan(0);

      // The state is persisted: a reload doesn't re-ask the server to find out.
      await page.reload();
      await expect(pausedNotice(page)).toBeVisible();
      await expect(linkRow(page, queued)).toBeVisible();

      // Resume from the OTHER tab: the username is the stored one, and locked.
      await other.getByRole('button', { name: 'Sign in to resume' }).click();
      const dialog = other.getByRole('dialog', { name: 'Sign in to resume' });
      await expect(dialog.locator('#username')).toHaveValue(credentials.username);
      await expect(dialog.locator('#username')).toHaveAttribute('readonly', '');
      await dialog.locator('#password').fill(newPassword);
      await dialog.getByRole('button', { name: /^Sign in$/ }).click();
      await expect(pausedNotice(other)).toHaveCount(0, { timeout: 60_000 });
      // …and this tab picks the resume up too, library untouched.
      await expect(pausedNotice(page)).toHaveCount(0, { timeout: 30_000 });
      await expect(linkRow(page, queued)).toBeVisible();

      // What queued while paused reaches the server.
      await syncAndWait(page);
      expect(await countPendingOps(page)).toBe(0);
      const reader = await launchApp(profileDir(`expired-reader-w${testInfo.workerIndex}`), {
        existing: { username: credentials.username, password: newPassword },
      });
      try {
        await reader.page.goto('/links');
        await syncAndWait(reader.page);
        await expect(linkRow(reader.page, queued)).toHaveCount(1);
      } finally {
        await reader.close();
      }
    },
  );

  // A token the server no longer has a row for — purged a year after it ended, or a
  // sessions table that was emptied (docs/sessions.md, _the sessions database_) —
  // answers `session_unknown`, which keeps everything exactly like an expiry. The
  // stored token is replaced by one the server never issued, which is what a purge
  // looks like from the device.
  test(
    'a token the server no longer knows keeps the library and an unsynced edit, and resumes',
    { tag: ['@SESSION-UNKNOWN-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      test.setTimeout(4 * 60 * 1000);
      const { page, credentials } = app;
      const kept = unresolvableUrl(unique('unknown-kept'));
      const unsynced = unresolvableUrl(unique('unknown-unsynced'));

      await page.goto('/links');
      await addLink(page, kept);
      await syncAndWait(page);

      await forgeStoredToken(page, `purged-${unique('tok')}`);
      await page.reload();
      await expect(linkRow(page, kept)).toBeVisible();

      // The edit kicks a cycle; that cycle is the request that learns it.
      await addLink(page, unsynced);
      await expect(pausedNotice(page)).toBeVisible({ timeout: 60_000 });
      await expect(page).toHaveURL(/\/links/);
      await expect(linkRow(page, kept)).toBeVisible();
      await expect(linkRow(page, unsynced)).toBeVisible();
      expect(await countPendingOps(page)).toBeGreaterThan(0);

      await page.getByRole('button', { name: 'Sign in to resume' }).click();
      const dialog = page.getByRole('dialog', { name: 'Sign in to resume' });
      await dialog.locator('#password').fill(credentials.password);
      await dialog.getByRole('button', { name: /^Sign in$/ }).click();
      await expect(pausedNotice(page)).toHaveCount(0, { timeout: 60_000 });

      await syncAndWait(page);
      expect(await countPendingOps(page)).toBe(0);
      await expect(linkRow(page, unsynced)).toBeVisible();
    },
  );

  test(
    'a delayed sign-out and revoked response cannot wipe a session resumed in another tab',
    { tag: ['@SESSION-RACE-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, context, credentials } = app;
      const kept = unresolvableUrl(unique('race-kept'));
      const queued = unresolvableUrl(unique('race-queued'));
      await page.goto('/links');
      await addLink(page, kept);
      await syncAndWait(page);
      await forgeStoredToken(page, `unknown-${unique('race')}`);
      await page.reload();
      await expect(pausedNotice(page)).toBeVisible({ timeout: 60_000 });

      const other = await context.newPage();
      await other.goto('/links');
      await expect(pausedNotice(other)).toBeVisible();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let started!: () => void;
      const requestStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      await page.route('**/v1/auth/sign-out', async (route) => {
        started();
        await held;
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: '{"error":"session_revoked"}',
        });
      });
      try {
        await page.getByRole('button', { name: /^More options/ }).click();
        await page.getByRole('menuitem', { name: 'Sign out' }).click();
        await requestStarted;
        await expect(page.getByTestId('sign-out-dialog')).toBeVisible();

        await other.getByRole('button', { name: 'Sign in to resume' }).click();
        const resume = other.getByRole('dialog', { name: 'Sign in to resume' });
        await resume.locator('#password').fill(credentials.password);
        await resume.getByRole('button', { name: /^Sign in$/ }).click();
        await expect(pausedNotice(other)).toHaveCount(0, { timeout: 60_000 });
        await expect(pausedNotice(page)).toHaveCount(0);
        // The replacement owns an edit that exists only on this device.
        await context.route('**/v1/ops/**', (route) => route.abort());
        await addLink(other, queued);
        expect(await countPendingOps(other)).toBeGreaterThan(0);

        const arrived = page.waitForResponse('**/v1/auth/sign-out');
        release();
        await arrived;
        await expect(page.getByTestId('sign-out-dialog')).toHaveCount(0);
        await expect(addLinkButton(page)).toBeEnabled();
        // A further round-trip through persisted auth proves the old continuation
        // finished without clearing the replacement or its unsynced edit.
        await expect(linkRow(page, queued)).toBeVisible();
        await other.reload();
        await expect(linkRow(other, queued)).toBeVisible();
        await expect(linkRow(other, kept)).toBeVisible();
        expect(await countPendingOps(other)).toBeGreaterThan(0);
      } finally {
        release();
      }
    },
  );

  // Two accounts, one browser profile, in turn. The local store is OWNED: the
  // sign-out wipe drops the account's ownership row with its data in one
  // transaction, and every local write checks that row inside its own
  // (docs/sessions.md, the account fence). So the next account must be handed a
  // store that is empty AND already claimed for it before its first write — a
  // sync cycle may never claim it — and the first account, back again, must find
  // its library on the server and nothing of the second one's here. Getting the
  // order wrong fails as a first write that throws, or a library that leaks;
  // neither is reachable with one account per profile.
  test(
    'a second account on the same profile starts empty and writable, and the first returns to only its own library',
    { tag: ['@WEB-ACCOUNT-004', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, credentials } = app;
      const site = await stubMarketingSite(page);
      const first = unresolvableUrl(unique('switch-first'));
      const second = unresolvableUrl(unique('switch-second'));
      const back = unresolvableUrl(unique('switch-back'));

      await page.goto('/links');
      await addLink(page, first);
      await syncAndWait(page);
      await signOutToSite(page, site);

      await createAccount(page, newCredentials());
      await expect(addLinkButton(page)).toBeVisible();
      await expect(linkRow(page, first)).toHaveCount(0);
      await addLink(page, second);
      await syncAndWait(page);
      await page.reload();
      await expect(linkRow(page, second)).toBeVisible();
      await expect(linkRow(page, first)).toHaveCount(0);
      await signOutToSite(page, site);

      // A sign-in, not a creation: its first pull fills the store it claimed.
      await signIn(page, credentials);
      await expect(linkRow(page, first)).toBeVisible({ timeout: 60_000 });
      await expect(linkRow(page, second)).toHaveCount(0);
      await addLink(page, back);
      await syncAndWait(page);
      await expect(linkRow(page, back)).toBeVisible();
    },
  );

  // /privacy says the api's request log is on and that no address in it contains
  // a username (_Technical and security data_), and for a stretch that was false:
  // the three lookups that run before a session exists were GETs with
  // `?username=…`, so each left the name in a stored log entry beside an IP
  // (docs/api-contracts.md, _a GET's query string reaches the request log_).
  // They are POSTs now. The unit layer pins the contracts' methods and the
  // routes that answer them; what it cannot reach is the request a real browser
  // sends once the hooks, the auth wrapper and the bundler have all had their
  // turn — a `fetch` built by hand beside the contract client, or a header a
  // wrapper adds, type-checks and leaves every one of those specs green.
  //
  // So: every request this profile sends the api across the journeys that name
  // an account — the recovery-door check Settings makes, a second account's
  // creation, and signing the first back in — and neither username may appear
  // in an address or a header of any of them. Headers too, because that log
  // stores them as sent.
  test(
    'no request to the api carries a username in its address or in a header',
    { tag: ['@WEB-ACCOUNT-005', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, context, credentials } = app;
      const site = await stubMarketingSite(page);
      const second = newCredentials();

      const sent: {
        method: string;
        url: string;
        headers: Record<string, string>;
        body: string | null;
      }[] = [];
      context.on('request', (request) => {
        if (!request.url().startsWith(`${API_URL}/`)) return;
        sent.push({
          method: request.method(),
          url: request.url(),
          headers: request.headers(),
          body: request.postData(),
        });
      });
      // The usernames a lookup's BODY named — the positive control for each
      // journey below. Without it, a client that stopped asking altogether would
      // pass the negative assertion at the end with nothing to have leaked.
      const named = (path: string) =>
        sent
          .filter((request) => request.method === 'POST' && new URL(request.url).pathname === path)
          .map((request) => (JSON.parse(request.body ?? '{}') as { username?: string }).username);

      // Signed in: Settings → Account asks whether this account has a recovery
      // door, through the same pre-auth lookup sign-in uses.
      await page.goto('/settings/account');
      await expect.poll(() => named('/v1/auth/read-recovery-door')).toContain(credentials.username);

      // A second account: the availability check fires on the typed name.
      await signOutToSite(page, site);
      await createAccount(page, second);
      expect(named('/v1/auth/check-username')).toContain(second.username);

      // And the first one back: the password-door read is sign-in's first step.
      await signOutToSite(page, site);
      await signIn(page, credentials);
      expect(named('/v1/auth/read-password-door')).toContain(credentials.username);

      const carried = sent.flatMap((request) =>
        [credentials.username, second.username].flatMap((username) => [
          ...(request.url.includes(username) ? [`${request.method} ${request.url}`] : []),
          ...Object.entries(request.headers)
            .filter(([, value]) => value.includes(username))
            .map(([name, value]) => `${request.method} ${request.url} — ${name}: ${value}`),
        ]),
      );
      expect(carried, 'a username left the body of a request to the api').toEqual([]);
    },
  );

  // THE SPECIMEN (docs/sessions.md): the client this replaced wiped itself once the
  // device clock passed the `expiresAt` it was handed at sign-in — a timed delete of
  // every library that would fire even with the server gone. There is no clock in
  // the client now; a session two years old on this device's clock is signed in.
  test(
    'a session minted two years ago on the device clock is still signed in, library intact',
    { tag: ['@WEB-ACCOUNT-003', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page } = app;
      const kept = unresolvableUrl(unique('clock-kept'));

      await page.goto('/links');
      await addLink(page, kept);
      await syncAndWait(page);

      await page.clock.setFixedTime(Date.now() + 2 * 365 * 24 * 60 * 60 * 1000);
      await page.reload();

      await expect(page).toHaveURL(/\/links/);
      await expect(linkRow(page, kept)).toBeVisible();
      await expect(pausedNotice(page)).toHaveCount(0);
      expect(await countSyncedItems(page)).toBeGreaterThan(0);
    },
  );

  // Change password on its DEFAULT path, the generated passphrase — every other
  // spec that rotates a password takes "Choose my own" (changePasswordElsewhere).
  // On the way it holds the two things this form owes a password manager and the
  // user, neither of which any other layer sees in a real browser:
  //   - the current password is refused as the new one (field-messages.ts);
  //   - the generated passphrase is IN THE FORM as a `new-password` input. It is
  //     shown in an <output>, which no manager reads, and without the input
  //     Chrome's save prompt carried the CURRENT password — the old one
  //     (new-password-field.tsx, `exposeGenerated`). The prompt itself is browser
  //     chrome, out of Playwright's reach; this asserts the field it saves from.
  // Then the passphrase has to actually sign in, or "the new password" is a string
  // on a screen.
  test(
    'change password on the generated path refuses the current one and signs in with the new',
    { tag: ['@WEB-ACCOUNT-006', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, credentials } = app;
      const site = await stubMarketingSite(page);

      await page.goto('/settings/account');
      await page.getByRole('button', { name: /^Change password/ }).click();
      await page.locator('#cp-current').fill(credentials.password);
      const submit = page.getByRole('button', { name: 'Change password', exact: true });

      await page.getByRole('button', { name: 'Choose my own' }).click();
      await page.locator('#cp-new-password').fill(credentials.password);
      await expect(page.getByText('That’s your current password.')).toBeVisible();
      await expect(submit).toBeDisabled();

      await page.getByRole('button', { name: 'Generate one instead' }).click();
      const passphrase = (await page.getByLabel('Your new password').innerText()).trim();
      expect(passphrase).not.toBe('');
      await expect(page.locator('form input[autocomplete="new-password"]')).toHaveValue(passphrase);

      await page.getByLabel('I’ve saved my new password somewhere safe.').check();
      await submit.click();
      await expect(page.getByText(/^Your password has been changed\./)).toBeVisible({
        timeout: 60_000,
      });

      await signOutToSite(page, site);
      await signIn(page, { username: credentials.username, password: passphrase });
    },
  );
});

// How many rows bracemark-web's local store holds — synced entities (`items`) and
// the unpushed queue (`pendingOps`) together. By the store's schema names
// (packages/web-react/src/data/db.ts), as fixtures/store-hold.ts addresses them:
// the teardown clears the tables and keeps the database, and an assertion
// through the UI could not tell "wiped" from "signed out and not shown".
async function countSyncedItems(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('bracemark-data');
        open.onerror = () => reject(open.error ?? new Error('indexedDB.open failed'));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['items', 'pendingOps'], 'readonly');
          const items = tx.objectStore('items').count();
          const pending = tx.objectStore('pendingOps').count();
          tx.oncomplete = () => {
            db.close();
            resolve(items.result + pending.result);
          };
          tx.onerror = () => reject(tx.error ?? new Error('count transaction failed'));
        };
      }),
  );
}

// The expired session's notice (apps/bracemark-web/src/components/sync-paused-notice.tsx),
// by the status its words carry.
// A deliberate sign-out from the menu, which leaves for the (stubbed) marketing site.
async function signOutToSite(page: Page, site: URL): Promise<void> {
  await page.goto('/links');
  // The label gains a suffix in the sync-failed / storage-full states.
  await page.getByRole('button', { name: /^More options/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL((url) => url.origin === site.origin, { timeout: 30_000 });
}

function pausedNotice(page: Page) {
  // Modal dialogs hide the underlying status from accessibility queries. Its
  // disappearance must mean resume landed, even while sign-out covers the page.
  return page.getByRole('status', { includeHidden: true }).filter({ hasText: 'Sync is paused' });
}

// Replace the bearer token in this profile's session record — what a purged row
// looks like from the device: the token is still sent, and the server has never
// heard of it. The record's other fields (the key, the generation) stay.
async function forgeStoredToken(page: Page, token: string): Promise<void> {
  await page.evaluate(
    (forged) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('bracemark-session');
        open.onerror = () => reject(open.error ?? new Error('indexedDB.open failed'));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('session', 'readwrite');
          const store = tx.objectStore('session');
          const read = store.get('current');
          read.onsuccess = () => {
            if (!read.result) {
              reject(new Error('no session record to forge'));
              return;
            }
            store.put({ ...read.result, token: forged }, 'current');
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error ?? new Error('forge transaction failed'));
        };
      }),
    token,
  );
}

// Change the account's password from a separate profile — the other device. Its
// own session stays; every other session is EXPIRED, never revoked
// (apps/bracemark-api/src/services/account.ts, changePasswordDoor).
async function changePasswordElsewhere(
  profile: string,
  credentials: Credentials,
  newPassword: string,
): Promise<void> {
  const other = await launchApp(profile, { existing: credentials });
  try {
    await other.page.goto('/settings/account');
    await other.page.getByRole('button', { name: /^Change password/ }).click();
    await other.page.locator('#cp-current').fill(credentials.password);
    await other.page.getByRole('button', { name: /choose my own/i }).click();
    await other.page.locator('#cp-new-password').fill(newPassword);
    await other.page.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(other.page.getByText(/^Your password has been changed\./)).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await other.close();
  }
}

async function requestSignOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^More options/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
}
