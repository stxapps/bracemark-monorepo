import { readFile } from 'node:fs/promises';

import { expect, type Page } from '@playwright/test';

// Settings → Data → Export all data, as plain text, from a page already on
// /settings/data. Plain text because it saves through an ordinary download, which
// Playwright can hold; the Bracemark backup claims a native save dialog on Chrome
// that it cannot (docs/e2e.md, _what e2e may not assert_). The claim every caller
// makes is the same — the local library leaves the device with the server out of
// reach — so the format that proves it most directly is the one used.
//
// Every caller exports with the api unreachable, so the receipt must say the file
// is this device's copy: that line is the contract a user relies on to know what
// they got, so the wording is asserted, not just the file.
export async function exportPlainTextOffline(page: Page): Promise<string> {
  await page.getByRole('button', { name: /^Export all data/ }).click();
  await page.getByRole('radio', { name: /^Plain text/ }).check();
  // The pre-export refresh retries a dead network before it gives up, so the
  // download arrives after the backoff, not at once.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 90_000 }),
    page.getByRole('button', { name: 'Export all data', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.txt$/);
  const path = await download.path();
  await expect(
    page.getByText(/^Exported \d+ links?\. Couldn’t refresh from the server first/),
  ).toBeVisible();
  return readFile(path, 'utf8');
}

// The four formats by the label the Export view's radio carries, and the file
// name each promises (the names e2e/web/RELEASE.md once checked by hand), spelled
// here rather than imported, like every expectation in e2e.
export type ExportFormatLabel = 'Bracemark backup' | 'HTML bookmarks' | 'CSV' | 'Plain text';

const EXPORT_FILE_NAME: Record<ExportFormatLabel, RegExp> = {
  'Bracemark backup': /^Bracemark backup \d{4}-\d{2}-\d{2}\.zip$/,
  'HTML bookmarks': /^Bracemark bookmarks \d{4}-\d{2}-\d{2}\.html$/,
  CSV: /^Bracemark bookmarks \d{4}-\d{2}-\d{2}\.csv$/,
  'Plain text': /^Bracemark links \d{4}-\d{2}-\d{2}\.txt$/,
};

// Settings → Data → Export all data in one format, saved to `path`; returns the
// receipt's text. The download is the real one the app makes — `downloadBlob`,
// an anchor with `download` set — which every format takes except the backup on
// a browser with `showSaveFilePicker`: there the app claims a native save dialog
// Playwright cannot drive (docs/e2e.md, _what e2e may not assert_). So a backup
// export refuses to start where that method exists, rather than hang on an
// invisible dialog; the case that exports one runs on Firefox, which has none.
// Stubbing the method away would prove nothing about the save path.
export async function exportToFile(
  page: Page,
  format: ExportFormatLabel,
  path: string,
): Promise<string> {
  await page.goto('/settings/data');
  await page.getByRole('button', { name: /^Export all data/ }).click();
  if (
    format === 'Bracemark backup' &&
    (await page.evaluate(() => 'showSaveFilePicker' in window))
  ) {
    throw new Error(
      'this browser has showSaveFilePicker, so a backup export opens a native save dialog ' +
        'no driver can answer — run the backup round trip on Firefox (e2e-web:firefox)',
    );
  }
  await page.getByRole('radio', { name: new RegExp(`^${format}`) }).check();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 90_000 }),
    page.getByRole('button', { name: 'Export all data', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(EXPORT_FILE_NAME[format]);
  await download.saveAs(path);
  const receipt = page.getByText(/^(Exported \d+ links?|The file was saved)/);
  await expect(receipt).toBeVisible();
  return (await receipt.innerText()).trim();
}
