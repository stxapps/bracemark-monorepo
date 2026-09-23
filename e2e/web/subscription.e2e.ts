import { type Locator, type Page } from '@playwright/test';

import { profileDir } from '../paths';
import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { launchApp } from './fixtures/launch';
import { addLinkButton, linkRow, openSidebarItem } from './fixtures/links';
import { grantPlus, grantPlusAndLoad, lapsePlus } from './fixtures/plan';
import { syncAndWait } from './fixtures/sync';
import { createInSettings, moveListUnder, settingsRow } from './fixtures/taxonomy';

// Phase 9: the subscription surface and the plan gates, against the real
// `GET /v1/iap/status` fold and — for IAP-WEB-001 — the real Paddle sandbox.
//
// What none of these do is BUY anything. A paid state is reached through the
// existing `manual` purchase source written to local D1 (fixtures/plan.ts), which
// is a production state rather than a test endpoint, and a checkout is opened and
// closed without a payment (docs/e2e.md, _subscriptions_, carries the argument
// and what the Paddle sandbox is left holding). Every case owns its account:
// each one either opens a checkout, which parks a pending row on the account
// that later status reads have to ask Paddle about, or moves the plan.

function currentPlan(page: Page): Locator {
  return page.getByRole('group', { name: 'Current plan' });
}

function planCard(page: Page, plan: string): Locator {
  return page.getByRole('group', { name: `${plan} plan` });
}

// The settings rail's link to a section — an in-app navigation, so the query
// cache (and with it whatever the Subscription section's Refresh just learned)
// survives it. A `goto` would start a fresh document, which re-reads the plan on
// its own and so could not tell a working Refresh from a broken one.
async function openSettingsSection(page: Page, label: string): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: label, exact: true }).click();
  await expect(
    page.getByRole('navigation').getByRole('link', { name: label, exact: true }),
  ).toHaveAttribute('aria-current', 'page');
}

async function refreshPlan(page: Page, plan: string): Promise<void> {
  await openSettingsSection(page, 'Subscription');
  await currentPlan(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(currentPlan(page).getByText(plan, { exact: true })).toBeVisible();
}

// The paywall is the gate CLOSED: the affordance stays visible and a press
// routes here (contexts/paywall-provider.tsx). Dismissed, so the next step
// starts from the section.
async function expectPaywall(page: Page, title: string): Promise<void> {
  const paywall = page.getByRole('dialog', { name: title });
  await expect(paywall.getByRole('link', { name: 'Upgrade to Plus' })).toBeVisible();
  await paywall.getByRole('button', { name: 'Not now' }).click();
  await expect(paywall).toHaveCount(0);
}

async function pressSetAppLock(page: Page): Promise<void> {
  await openSettingsSection(page, 'Misc.');
  await page.getByRole('button', { name: 'Set app lock…' }).click();
}

// "Move to" under a parent, from the row kebab, on the section as it is mounted.
async function pressMoveUnder(page: Page, child: string, parent: string): Promise<void> {
  await settingsRow(page, 'list', child).getByRole('button', { name: 'List actions' }).click();
  await page.getByRole('menuitem', { name: 'Move to' }).hover();
  await page.getByRole('option', { name: parent, exact: true }).click();
}

function nested(page: Page, parent: string): Locator {
  return settingsRow(page, 'list', parent).getByRole('button', { name: 'Collapse' });
}

// Paddle's overlay is a third-party iframe on *.paddle.com. Its close control is
// Paddle's own, named by Paddle's own `data-testid` and nothing else — it has no
// accessible name — so this is the one selector here that another company can
// break. If it does, the case goes red at this line, which is the honest
// outcome: the alternative (`Paddle.Checkout.close()` from the page) would close
// an overlay no person could.
const OVERLAY = 'iframe.paddle-frame-overlay';

async function closeOverlay(page: Page): Promise<void> {
  const close = page.frameLocator(OVERLAY).getByTestId('wideOverlayCloseIcon');
  await expect(close).toBeVisible({ timeout: 30_000 });
  await close.click();
  await expect(page.locator(OVERLAY)).toBeHidden();
}

async function startCheckout(page: Page, card: Locator): Promise<string> {
  const created = page.waitForResponse(
    (response) =>
      response.url().endsWith('/v1/iap/checkout') && response.request().method() === 'POST',
  );
  await card.getByRole('button', { name: 'Upgrade to Plus' }).click();
  const response = await created;
  expect(response.status()).toBe(200);
  const { transactionId } = (await response.json()) as { transactionId: string };
  expect(transactionId).toMatch(/^txn_[a-z\d]+$/);
  return transactionId;
}

// Back on the section with nothing bought: the card's button is live again, no
// error was raised, and the account the server folds is still free.
async function expectReturnedFree(page: Page, card: Locator): Promise<void> {
  await expect(card.getByRole('button', { name: 'Upgrade to Plus' })).toBeEnabled();
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await expect(currentPlan(page).getByText('Free', { exact: true })).toBeVisible();
}

test.describe('subscriptions', () => {
  test(
    'a free account sees the Plus price and checkout, and closes the overlay without buying',
    { tag: ['@IAP-WEB-001', '@full', '@online', '@internet'] },
    async ({ isolatedApp: app }) => {
      const { page } = app;
      await page.goto('/settings/subscription');
      await expect(currentPlan(page).getByText('Free', { exact: true })).toBeVisible();

      // --- the affordance: the plan, its price, the button, the terms ---------
      const card = planCard(page, 'Plus');
      await expect(card.getByRole('button', { name: 'Upgrade to Plus' })).toBeEnabled();
      // The card prints the base price (`$48/year`, plans.ts) until Paddle's
      // preview for THIS buyer answers, then that preview — their currency, their
      // tax, the number the overlay will repeat. Waiting for it to stop being the
      // placeholder is waiting for Paddle.js to load and price the on-sale
      // `pri_…` the api named (`GET /v1/iap/prices`); a preview that failed
      // leaves the placeholder and fails here. The figure itself is not asserted:
      // it depends on where this machine geolocates.
      const price = card.getByText(/\/year$/);
      await expect(price).toBeVisible();
      await expect(price).not.toHaveText('$48/year', { timeout: 30_000 });
      await expect(page.getByRole('link', { name: 'Terms of Service' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Privacy Policy' })).toBeVisible();

      // --- open the real checkout, then back out of it -------------------------
      const first = await startCheckout(page, card);
      await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 30_000 });
      // While it is open the section is busy and offers nothing to press twice.
      await expect(card.getByRole('button', { name: 'Opening checkout…' })).toBeDisabled();
      await closeOverlay(page);
      await expectReturnedFree(page, card);

      // --- come back to it -----------------------------------------------------
      // A second press inside the checkout window re-uses the pending
      // transaction rather than minting a second payable one (docs/iap.md,
      // _the purchase flow (Paddle Billing — web)_, step 1). The server's
      // idempotency is unit-tested; this is the browser reaching it.
      expect(await startCheckout(page, card)).toBe(first);
      await closeOverlay(page);
      await expectReturnedFree(page, card);

      // The other way back: Paddle's payment link, which this page IS. Arriving
      // on it strips the id from the address bar at once and opens that
      // checkout (subscription-section.tsx, PAYMENT_LINK_PARAM).
      await page.goto(`/settings/subscription?_ptxn=${first}`);
      await expect(page).toHaveURL(/\/settings\/subscription$/);
      await expect(page.locator(OVERLAY)).toBeVisible({ timeout: 30_000 });
      await closeOverlay(page);
      await expectReturnedFree(page, planCard(page, 'Plus'));

      // And the server agrees nothing happened: a status re-read is still free.
      await refreshPlan(page, 'Free');
    },
  );

  test(
    'a manual Plus grant opens the plan gates after a Refresh, without a reload',
    { tag: ['@IAP-ENTITLEMENT-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, credentials } = app;
      const parent = unique('E2E plan parent');
      const child = unique('E2E plan child');
      await createInSettings(page, 'list', parent);
      await createInSettings(page, 'list', child);

      // --- free: both gates closed ---------------------------------------------
      await pressMoveUnder(page, child, parent);
      await expectPaywall(page, 'Nested lists');
      await expect(nested(page, parent)).toHaveCount(0);
      await pressSetAppLock(page);
      await expectPaywall(page, 'Locks');

      // --- the grant, and the client learning of it ---------------------------
      // The row lands server-side only. The status query holds a 5-minute
      // staleTime, so nothing re-asks by itself; the section's Refresh is the
      // user's way to, and everything after it is an in-app navigation on the
      // same document.
      await grantPlus(credentials.username);
      await refreshPlan(page, 'Plus');
      await expect(planCard(page, 'Plus')).toHaveCount(0);

      // --- Plus: the same presses now open the features ------------------------
      await pressSetAppLock(page);
      const setLock = page.getByRole('dialog', { name: 'Set app lock' });
      await expect(setLock.getByLabel('Password', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(setLock).toHaveCount(0);

      await openSettingsSection(page, 'Lists');
      await pressMoveUnder(page, child, parent);
      await expect(nested(page, parent)).toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Nested lists' })).toHaveCount(0);
    },
  );

  test(
    'a lapsed plan keeps its nested data readable and closes the gated create paths',
    { tag: ['@IAP-DOWNGRADE-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, credentials } = app;
      await grantPlusAndLoad(page, credentials.username);

      // --- what Plus built: a nested list with a link filed inside it ---------
      const parent = unique('E2E lapse parent');
      const child = unique('E2E lapse child');
      const later = unique('E2E lapse later');
      const filed = unresolvableUrl(unique('lapse-filed'));
      await createInSettings(page, 'list', parent);
      await createInSettings(page, 'list', child);
      await createInSettings(page, 'list', later);
      await moveListUnder(page, child, parent);

      await page.goto('/links');
      await addLinkButton(page).click();
      await page.locator('#link-url').fill(filed);
      await page.getByRole('button', { name: 'List, tags & note' }).click();
      await page.getByRole('combobox', { name: 'List' }).click();
      await page.getByPlaceholder('Search or create lists…').fill(child);
      await page.getByRole('option', { name: new RegExp(`${child}$`) }).click();
      await page.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
      await expect(page.locator('#link-url')).toHaveCount(0);
      await syncAndWait(page);

      // --- the plan ends; this client re-reads it ------------------------------
      await lapsePlus(credentials.username);
      await page.goto('/settings/lists');
      await refreshPlan(page, 'Free');
      await expect(planCard(page, 'Plus')).toBeVisible();

      // --- what it built is all still there ------------------------------------
      await openSettingsSection(page, 'Lists');
      await expect(nested(page, parent)).toBeVisible();
      // ...and still readable by a client that meets the account only now, on
      // the free plan: a pull is GETs, which no plan gates (docs/iap.md,
      // _enforcement_ — read-only-plus-delete, never data loss).
      const reader = await launchApp(profileDir(`${test.info().testId}-reader`.slice(-80)), {
        existing: credentials,
      });
      try {
        await reader.page.goto('/links');
        await syncAndWait(reader.page);
        await openSidebarItem(reader.page, child);
        await expect(linkRow(reader.page, filed)).toHaveCount(1);
      } finally {
        await reader.close();
      }

      // --- and the create paths the plan paid for are closed again ------------
      await pressMoveUnder(page, later, parent);
      await expectPaywall(page, 'Nested lists');
      await pressSetAppLock(page);
      await expectPaywall(page, 'Locks');
    },
  );
});
