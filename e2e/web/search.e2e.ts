import { type Locator, type Page } from '@playwright/test';

import { importArchive } from '../seed/steps';
import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { writePagedLibrary } from './fixtures/library';
import { addLink, addLinkButton, linkRow, openSidebarItem } from './fixtures/links';
import { grantPlus } from './fixtures/plan';
import { expectRowAtTop, scrollerOf, scrollTop, scrollUntilRendered } from './fixtures/scroll';
import { createInSettings } from './fixtures/taxonomy';

// The links page's search, as the URL and the rows agree on it. The grammar, the
// two writers and `restorePreSearch` are pinned by unit and component specs
// (docs/search.md); what only a browser shows is the whole loop — a committed
// query becoming history the router can restore, the read engine answering it
// against a real Dexie, and the pane's scroller outliving the view it scrolled.

function searchBox(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Search links' });
}

// The topbar title. The h1 holds a narrow-width drawer label beside the wide one,
// so its text content repeats; its accessible name does not.
function pageTitle(page: Page, name: string): Locator {
  return page.getByRole('heading', { level: 1, name, exact: true });
}

function params(page: Page, key: string): string[] {
  return new URL(page.url()).searchParams.getAll(key);
}

test.describe('search', () => {
  test(
    'a committed text search and its clearing keep the URL and the rows in agreement',
    { tag: ['@SEARCH-001', '@full', '@online'] },
    async ({ page }) => {
      const word = unique('findme').toLowerCase();
      const match = unresolvableUrl(`${word}-match`);
      const miss = unresolvableUrl(unique('nomatch'));

      await page.goto('/links');
      await addLink(page, match);
      await addLink(page, miss);

      await searchBox(page).fill(word);
      await searchBox(page).press('Enter');
      await expect(page).toHaveURL(/[?&]text=/);
      expect(params(page, 'text')).toEqual([word]);
      await expect(pageTitle(page, 'Search')).toBeVisible();
      await expect(linkRow(page, match)).toHaveCount(1);
      await expect(linkRow(page, miss)).toHaveCount(0);

      // Clearing is an abort: back to the view the search started from, with no
      // query left in the URL.
      await page.getByRole('button', { name: 'Clear search' }).click();
      await expect(page).not.toHaveURL(/[?&]text=/);
      expect(new URL(page.url()).pathname).toBe('/links');
      await expect(searchBox(page)).toHaveValue('');
      await expect(pageTitle(page, 'My List')).toBeVisible();
      await expect(linkRow(page, match)).toHaveCount(1);
      await expect(linkRow(page, miss)).toHaveCount(1);
    },
  );

  test(
    'an advanced list, tag and text query is restored by history and by the settings round trip',
    { tag: ['@SEARCH-002', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      // Its own account on Plus: the structured editor is the `searchEditor`
      // lever, and a free account's Search opens the paywall.
      const { page, credentials } = app;
      await grantPlus(credentials.username);

      const list = unique('E2e search list');
      const tag = unique('e2e-search-tag');
      const word = unique('advword').toLowerCase();
      // One link satisfies all three clauses; each other one misses exactly one.
      const all = unresolvableUrl(`${word}-all-three`);
      const noWord = unresolvableUrl(unique('no-word'));
      const noTag = unresolvableUrl(`${word}-no-tag`);
      const noList = unresolvableUrl(`${word}-no-list`);

      await createInSettings(page, 'list', list);
      await createInSettings(page, 'tag', tag);
      await page.goto('/links');
      for (const [url, inList, withTag] of [
        [all, true, true],
        [noWord, true, true],
        [noTag, true, false],
        [noList, false, true],
      ] as const) {
        await addLinkButton(page).click();
        await page.locator('#link-url').fill(url);
        await page.getByRole('button', { name: 'List, tags & note' }).click();
        if (inList) {
          await page.getByRole('combobox', { name: 'List' }).click();
          await page.getByPlaceholder('Search or create lists…').fill(list);
          await page.getByRole('option', { name: list, exact: true }).click();
        }
        if (withTag) {
          await page.getByRole('combobox', { name: 'Tags' }).click();
          await page.getByPlaceholder('Search or create tags…').fill(tag);
          await page.getByRole('option', { name: tag, exact: true }).click();
          await page.keyboard.press('Escape');
        }
        await page.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
        await expect(page.locator('#link-url')).toHaveCount(0);
      }

      const expectResults = async () => {
        await expect(linkRow(page, all)).toHaveCount(1);
        for (const url of [noWord, noTag, noList]) await expect(linkRow(page, url)).toHaveCount(0);
      };

      // --- commit -----------------------------------------------------------------
      await page.getByRole('button', { name: 'Advanced search' }).click();
      // The editor opens on the committed query, and bare /links IS a query — the
      // default inbox. A row cycles include → exclude → off, so My List takes two.
      await page.getByRole('checkbox', { name: 'My List: included' }).click();
      await page.getByRole('checkbox', { name: 'My List: excluded' }).click();
      await expect(page.getByRole('checkbox', { name: 'My List: not selected' })).toBeVisible();
      await page.locator('#adv-text-all').fill(word);
      await page.getByRole('checkbox', { name: `${list}: not selected` }).click();
      await page.getByRole('checkbox', { name: `${tag}: not selected` }).click();
      await page.getByRole('button', { name: 'Search', exact: true }).click();

      await expect(page).toHaveURL(/[?&]text=/);
      expect(params(page, 'text')).toEqual([word]);
      expect(params(page, 'list')).toHaveLength(1);
      expect(params(page, 'tag')).toHaveLength(1);
      const committed = page.url();
      await expect(pageTitle(page, 'Search')).toBeVisible();
      await expectResults();

      // --- leave, then Back -------------------------------------------------------
      await page.getByRole('button', { name: /^More options/ }).click();
      await page.getByRole('menuitem', { name: 'Settings' }).click();
      await expect(page).toHaveURL(/\/settings\//);
      await page.goBack();
      await expect(page).toHaveURL(committed);
      await expectResults();

      // --- leave, then the settings ✕ ---------------------------------------------
      await page.getByRole('button', { name: /^More options/ }).click();
      await page.getByRole('menuitem', { name: 'Settings' }).click();
      await expect(page).toHaveURL(/\/settings\//);
      await page.getByRole('link', { name: 'Close settings' }).click();
      await expect(page).toHaveURL(committed);
      await expectResults();

      // The restored query is the editor's too: every clause round-trips into it.
      await page.getByRole('button', { name: 'Advanced search' }).click();
      await expect(page.locator('#adv-text-all')).toHaveValue(word);
      await expect(page.getByRole('checkbox', { name: `${list}: included` })).toBeVisible();
      await expect(page.getByRole('checkbox', { name: `${tag}: included` })).toBeVisible();
    },
  );

  test(
    'a changed view starts at its top, not at the offset the paged view left',
    { tag: ['@SEARCH-SCROLL-001', '@full', '@online', '@destructive', '@scale'] },
    async ({ isolatedApp: app }, testInfo) => {
      // 120 links in My List: two pages and a half past PAGE_SIZE (50), so the
      // first view can be paged twice and scrolled far past anything the next
      // view's first page is tall.
      const { page } = app;
      const word = unique('scrollfix').toLowerCase();
      const library = await writePagedLibrary(testInfo.outputPath('paged.zip'), {
        count: 120,
        label: word,
      });
      await importArchive(page, library.archivePath);

      await page.goto('/links');
      const first = library.urls[0];
      // The last row only renders once infinite scroll has grown the page twice.
      const deep = library.urls[library.urls.length - 1];
      await expect(linkRow(page, first)).toBeVisible();
      const scroller = await scrollerOf(linkRow(page, first));

      // --- My List, paged to its last row -----------------------------------------
      await scrollUntilRendered(page, scroller, deep);
      expect(await scrollTop(scroller)).toBeGreaterThan(1000);

      // --- a committed search: a new query, the same scroller ---------------------
      await searchBox(page).fill(word);
      await searchBox(page).press('Enter');
      await expect(page).toHaveURL(/[?&]text=/);
      await expectRowAtTop(page, scroller, first);

      // --- paged again, then a sidebar pick -----------------------------------------
      await scrollUntilRendered(page, scroller, deep);
      expect(await scrollTop(scroller)).toBeGreaterThan(1000);
      await openSidebarItem(page, 'Show All');
      await expectRowAtTop(page, scroller, first);
    },
  );
});
