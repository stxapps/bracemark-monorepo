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
