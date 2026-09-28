import { type Page } from '@playwright/test';

import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { addLinkButton, displayUrl, linkRow, openSidebarItem } from './fixtures/links';
import { grantPlusAndLoad } from './fixtures/plan';
import { createInSettings, lockListInSettings, moveListUnder } from './fixtures/taxonomy';

// The device-local app lock and list locks, over a real Dexie and a real load.
// Coverage and the verifier have unit specs (docs/locks.md); what only a browser
// shows is the gate winning the race against the first paint, the in-memory
// unlock dying with the page, and the covered links being absent from the
// document itself rather than merely out of view.

// Record, from before the first script runs, every moment app content or the
// lock screen is attached. MutationObserver callbacks run before the next paint,
// so a flash of content that is removed again inside one frame is still seen.
// Read-only instrumentation: it changes nothing the page does.
async function traceContent(page: Page, url: string) {
  await page.addInitScript((href) => {
    const trace: string[] = [];
    (window as unknown as { __lockTrace: string[] }).__lockTrace = trace;
    const record = () => {
      const app =
        document.querySelector(`a[href="${href}"]`) ??
        document.querySelector('header button[aria-label="Add link"]');
      const lock = document.querySelector('input[aria-label="Password"]');
      const state = app ? 'app' : lock ? 'lock' : 'blank';
      if (trace[trace.length - 1] !== state) trace.push(state);
    };
    new MutationObserver(record).observe(document, { childList: true, subtree: true });
  }, url);
}

async function readTrace(page: Page): Promise<string[]> {
  return await page.evaluate(() => (window as unknown as { __lockTrace: string[] }).__lockTrace);
}

async function unlockPane(page: Page, password: string) {
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
}

test.describe('locks', () => {
  test(
    'the app lock gates a reload without a flash, refuses a wrong password, opens, and relocks',
    { tag: ['@LOCK-APP-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const { page, credentials } = app;
      await grantPlusAndLoad(page, credentials.username);
      const anchor = unresolvableUrl(unique('app-lock-anchor'));
      const password = unique('app-lock-password');

      await addLinkButton(page).click();
      await page.locator('#link-url').fill(anchor);
      await page.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
      await expect(linkRow(page, anchor)).toHaveCount(1);

      await page.goto('/settings/misc');
      await page.getByRole('button', { name: 'Set app lock…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Set app lock' });
      await dialog.getByLabel('Password', { exact: true }).fill(password);
      await dialog.getByRole('button', { name: 'Set lock', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      // Setting it does not slam the gate on the spot; it engages next load.
      await expect(page.getByRole('button', { name: 'Remove app lock…' })).toBeVisible();

      // --- the reload -----------------------------------------------------------
      await traceContent(page, anchor);
      await page.goto('/links');
      await expect(page.getByRole('heading', { name: 'Bracemark is locked' })).toBeVisible();
      await expect(linkRow(page, anchor)).toHaveCount(0);
      expect(await readTrace(page)).not.toContain('app');

      // --- wrong, then right ----------------------------------------------------
      await unlockPane(page, `${password}-wrong`);
      // Filtered: Next's route announcer is a role="alert" too.
      await expect(
        page.getByRole('alert').filter({ hasText: /Password isn’t correct/ }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Bracemark is locked' })).toBeVisible();
      expect(await readTrace(page)).not.toContain('app');

      await unlockPane(page, password);
      await expect(linkRow(page, anchor)).toHaveCount(1);
      // Positive control: the same observer does see content once it is allowed.
      expect(await readTrace(page)).toContain('app');

      // Relock from the topbar menu, without a load: the gate closes on the spot,
      // and the same password opens the same app again.
      await page.getByRole('button', { name: /^More options/ }).click();
      await page.getByRole('menuitem', { name: 'Lock app' }).click();
      await expect(page.getByRole('heading', { name: 'Bracemark is locked' })).toBeVisible();
      await expect(linkRow(page, anchor)).toHaveCount(0);
      await unlockPane(page, password);
      await expect(linkRow(page, anchor)).toHaveCount(1);

      // The unlock lives in memory only: the next load is locked again.
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Bracemark is locked' })).toBeVisible();
      await expect(linkRow(page, anchor)).toHaveCount(0);
    },
  );

  test(
    'a parent list lock keeps a child list’s links out of every read until the covering lock opens',
    { tag: ['@LOCK-LIST-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      // Plus twice over: the nesting and the lock.
      const { page, credentials } = app;
      await grantPlusAndLoad(page, credentials.username);
      const parent = unique('E2e lock parent');
      const child = unique('E2e lock child');
      const tag = unique('e2e-lock-tag');
      const word = unique('coverword').toLowerCase();
      const covered = unresolvableUrl(`${word}-covered`);
      // Shares the tag and the word, and is in no locked list: the positive
      // control that each read actually ran.
      const open = unresolvableUrl(`${word}-open`);
      const password = unique('parent-lock-password');

      await createInSettings(page, 'list', parent);
      await createInSettings(page, 'list', child);
      await createInSettings(page, 'tag', tag);
      await moveListUnder(page, child, parent);

      await page.goto('/links');
      for (const [url, list] of [
        [covered, child],
        [open, null],
      ] as const) {
        await addLinkButton(page).click();
        await page.locator('#link-url').fill(url);
        await page.getByRole('button', { name: 'List, tags & note' }).click();
        if (list) {
          await page.getByRole('combobox', { name: 'List' }).click();
          await page.getByPlaceholder('Search or create lists…').fill(list);
          // A filtered picker names a nested list by its path.
          await page.getByRole('option', { name: `${parent} / ${list}`, exact: true }).click();
        }
        await page.getByRole('combobox', { name: 'Tags' }).click();
        await page.getByPlaceholder('Search or create tags…').fill(tag);
        await page.getByRole('option', { name: tag, exact: true }).click();
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
        await expect(page.locator('#link-url')).toHaveCount(0);
      }

      // Only the PARENT is locked; the child carries no lock of its own.
      await lockListInSettings(page, parent, password);
      await page.goto('/links');

      const expectCoveredAbsent = async () => {
        await expect(page.locator('main')).not.toContainText(displayUrl(covered));
        expect(await page.content()).not.toContain(covered);
      };

      // --- browse the child: the lock pane, and no links mounted ----------------
      await openSidebarItem(page, child);
      await expect(page.getByRole('heading', { name: 'This list is locked' })).toBeVisible();
      await expectCoveredAbsent();

      // --- Show All, the tag, a search ------------------------------------------
      await openSidebarItem(page, 'Show All');
      await expect(linkRow(page, open)).toHaveCount(1);
      await expectCoveredAbsent();

      await openSidebarItem(page, tag);
      await expect(linkRow(page, open)).toHaveCount(1);
      await expectCoveredAbsent();

      await page.getByRole('textbox', { name: 'Search links' }).fill(word);
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/[?&]text=/);
      await expect(linkRow(page, open)).toHaveCount(1);
      await expectCoveredAbsent();

      // --- unlock through the covering lock, from the child's pane --------------
      await openSidebarItem(page, child);
      await unlockPane(page, `${password}-wrong`);
      // Filtered: Next's route announcer is a role="alert" too.
      await expect(
        page.getByRole('alert').filter({ hasText: /Password isn’t correct/ }),
      ).toBeVisible();
      await expectCoveredAbsent();
      await unlockPane(page, password);
      await expect(linkRow(page, covered)).toHaveCount(1);

      // The parent's lock is what opened, so every read has the link back.
      await openSidebarItem(page, tag);
      await expect(linkRow(page, covered)).toHaveCount(1);
      await openSidebarItem(page, 'Show All');
      await expect(linkRow(page, covered)).toHaveCount(1);
    },
  );
});
