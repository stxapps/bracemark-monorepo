import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { addLink, displayUrl } from './fixtures/links';

test.describe('delete all data', () => {
  test(
    'repaints an already-open links page after the wipe',
    { tag: ['@DATA-DELETE-ALL-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp: app }) => {
      const settingsPage = app.page;
      const linksPage = await app.context.newPage();
      const url = unresolvableUrl('delete-all');
      const list = unique('E2e delete list');
      const tag = unique('E2e delete tag');

      await linksPage.goto('/links');
      await addLink(linksPage, url);

      await settingsPage.goto('/settings/lists');
      const newList = settingsPage.getByLabel('New list name');
      await newList.fill(list);
      await newList.press('Enter');
      await expect(
        settingsPage.locator(`input[aria-label="List name"][value="${list}"]`),
      ).toBeVisible();

      await settingsPage.goto('/settings/tags');
      const newTag = settingsPage.getByLabel('New tag name');
      await newTag.fill(tag);
      await newTag.press('Enter');
      await expect(
        settingsPage.locator(`input[aria-label="Tag name"][value="${tag}"]`),
      ).toBeVisible();

      // This page remains mounted throughout the deletion in the other tab. It
      // directly proves Dexie's clear/deleteRange observability wakes liveQuery,
      // rather than passing because a return navigation mounted fresh readers.
      await expect(linksPage.getByText(displayUrl(url))).toBeVisible();
      await expect(linksPage.getByRole('button', { name: list })).toBeVisible();
      await expect(linksPage.getByRole('button', { name: tag })).toBeVisible();

      await settingsPage.goto('/settings/data');
      await settingsPage.getByRole('button', { name: /^Delete all data/ }).click();
      await settingsPage.locator('#delete-confirm').check();
      await settingsPage.getByRole('button', { name: 'Delete all data', exact: true }).click();
      await expect(settingsPage.getByText(/All your data has been deleted/)).toBeVisible();

      await expect(linksPage.getByText(displayUrl(url))).not.toBeVisible();
      await expect(linksPage.getByRole('button', { name: list })).not.toBeVisible();
      await expect(linksPage.getByRole('button', { name: tag })).not.toBeVisible();
      await expect(linksPage.getByRole('button', { name: 'My List' })).toBeVisible();
      await expect(linksPage.getByRole('button', { name: 'Archive' })).toBeVisible();
      await expect(linksPage.getByRole('button', { name: 'Trash' })).toBeVisible();
    },
  );
});
