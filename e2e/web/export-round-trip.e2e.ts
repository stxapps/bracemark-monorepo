import { type Page } from '@playwright/test';

import { profileDir } from '../paths';
import { expect, test } from './fixtures/app';
import { unique } from './fixtures/data';
import {
  importFile,
  type RoundTripLibrary,
  writeRoundTripLibrary,
} from './fixtures/data-lifecycle';
import { type ExportFormatLabel, exportToFile } from './fixtures/export';
import { launchApp, type LaunchedApp } from './fixtures/launch';
import { chooseRowMenuItem, linkRow, openSidebarItem } from './fixtures/links';
import { nameField, settingsRow } from './fixtures/taxonomy';

// Export in each format, import the file into a fresh account, and read back what
// that format promises to carry (docs/data-lifecycle.md, _export_):
//
//   backup     title, nested list, tags, note, pin, image — and Trash, in Trash
//   HTML       title, nested list, tags                   — Trash left out
//   CSV        title, nested list, tags, note             — Trash left out
//   plain text the URLs                                   — Trash left out
//
// Only what a format promises is asserted, never what it drops: the interop
// formats are lossy by design, and a spec that pinned today's losses (no note in
// the app's HTML, no pins outside the backup) would turn them into a contract.
// Trash is the exception because leaving it out IS the promise — the Export view
// says so beside the HTML and CSV options. Nor is the library compared whole:
// one row carries every promised field, so each format's contract is a handful
// of reads on that row (docs/e2e.md, _the export round trip_).
//
// Each import goes to a fresh account, the restore-on-a-new-device shape:
// importing back into the source would dedupe every row and prove nothing about
// what the file carries.

async function expectNested(page: Page, parent: string, child: string): Promise<void> {
  await page.goto('/settings/lists');
  await expect(nameField(page, 'list', child)).toBeVisible();
  // The child is the parent's, not a sibling: collapsing the parent hides it.
  await settingsRow(page, 'list', parent).getByRole('button', { name: 'Collapse' }).click();
  await expect(nameField(page, 'list', child)).toHaveCount(0);
}

async function expectFullRow(
  page: Page,
  library: RoundTripLibrary,
  carries: { note: boolean },
): Promise<void> {
  await page.goto('/links');
  await openSidebarItem(page, library.childList);
  const row = linkRow(page, library.full.url);
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(library.full.title);

  await chooseRowMenuItem(page, library.full.url, 'Edit');
  const dialog = page.getByRole('dialog', { name: 'Edit link' });
  await expect(dialog.getByRole('textbox', { name: 'Title' })).toHaveValue(library.full.title);
  await expect(dialog.getByRole('combobox', { name: 'List' })).toContainText(library.childList);
  for (const tag of library.tags) {
    await expect(dialog.getByRole('button', { name: `Remove ${tag}` })).toBeVisible();
  }
  if (carries.note) {
    await expect(dialog.getByRole('textbox', { name: 'Note' })).toHaveValue(library.full.note);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

async function expectInMyList(page: Page, url: string): Promise<void> {
  await page.goto('/links');
  await openSidebarItem(page, 'My List');
  await expect(linkRow(page, url)).toHaveCount(1);
}

// The source account: a fresh one holding exactly the round-trip library.
async function seedSource(source: LaunchedApp, archivePath: string): Promise<RoundTripLibrary> {
  const library = await writeRoundTripLibrary(archivePath, unique('E2E round trip'));
  expect(await importFile(source.page, library.archivePath)).toMatch(
    /^Imported 3 links and 1 file\./,
  );
  return library;
}

test.describe('export round trip', () => {
  // Fixture setup, a seed import, then per format an export and a fresh account
  // (one Argon2id derivation each) importing it.
  test.describe.configure({ timeout: 6 * 60 * 1000 });

  test(
    'HTML, CSV and plain-text exports each import into a fresh account with what the format carries',
    { tag: ['@DATA-ROUNDTRIP-WEB-001', '@full', '@online'] },
    async ({ isolatedApp: source }, testInfo) => {
      const library = await seedSource(source, testInfo.outputPath('round-trip-source.zip'));

      const formats: {
        format: ExportFormatLabel;
        file: string;
        carries: 'tree' | 'urls';
        note: boolean;
      }[] = [
        { format: 'HTML bookmarks', file: 'round-trip.html', carries: 'tree', note: false },
        { format: 'CSV', file: 'round-trip.csv', carries: 'tree', note: true },
        { format: 'Plain text', file: 'round-trip.txt', carries: 'urls', note: false },
      ];
      for (const { format, file, carries, note } of formats) {
        await test.step(format, async () => {
          const path = testInfo.outputPath(file);
          // Two, not three: the trashed link stays behind.
          expect(await exportToFile(source.page, format, path)).toMatch(/^Exported 2 links\./);

          const target = await launchApp(profileDir(`round-trip-${file}-w${testInfo.workerIndex}`));
          try {
            expect(await importFile(target.page, path)).toMatch(/^Imported 2 links\./);
            await expectInMyList(target.page, library.plain.url);
            if (carries === 'tree') {
              await expectNested(target.page, library.parentList, library.childList);
              await expectFullRow(target.page, library, { note });
            } else {
              // A URL and nothing else, so it lands where an unfiled link does.
              await expectInMyList(target.page, library.full.url);
            }
            await openSidebarItem(target.page, 'Trash');
            await expect(linkRow(target.page, library.trashed.url)).toHaveCount(0);
          } finally {
            await target.close();
          }
        });
      }
    },
  );

  test(
    'a Bracemark backup restores every field, Trash included, and re-importing it duplicates nothing',
    { tag: ['@DATA-ROUNDTRIP-WEB-002', '@full', '@online'] },
    async ({ isolatedApp: source }, testInfo) => {
      const library = await seedSource(source, testInfo.outputPath('round-trip-source.zip'));
      const path = testInfo.outputPath('round-trip-backup.zip');
      // All three links, the trashed one included, and the image.
      expect(await exportToFile(source.page, 'Bracemark backup', path)).toMatch(
        /^Exported 3 links and 1 file\./,
      );

      const target = await launchApp(profileDir(`round-trip-backup-w${testInfo.workerIndex}`));
      try {
        expect(await importFile(target.page, path)).toMatch(
          /^Imported 3 links and 1 file\. Added 2 lists and 2 tags\./,
        );
        await expectNested(target.page, library.parentList, library.childList);
        await expectFullRow(target.page, library, { note: true });
        const full = linkRow(target.page, library.full.url);
        await expect(full.getByLabel('Pinned')).toBeVisible();
        await expect(full.locator('img[src^="blob:"]')).toHaveCount(1, { timeout: 30_000 });
        await expectInMyList(target.page, library.plain.url);
        await openSidebarItem(target.page, 'Trash');
        const trashed = linkRow(target.page, library.trashed.url);
        await expect(trashed).toHaveCount(1);
        await expect(trashed).toContainText(library.trashed.title);
      } finally {
        await target.close();
      }

      // A restore merges skip-existing by path, so the same backup into the
      // library it came from writes nothing and leaves one row per link.
      const again = await importFile(source.page, path);
      expect(again).toMatch(/^Imported 0 links\./);
      expect(again).toMatch(/duplicates were skipped\./);
      await source.page.goto('/links');
      await openSidebarItem(source.page, library.childList);
      await expect(linkRow(source.page, library.full.url)).toHaveCount(1);
      await expectInMyList(source.page, library.plain.url);
    },
  );
});
