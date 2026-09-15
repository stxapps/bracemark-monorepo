import { expect, type Page } from '@playwright/test';

// The steps a seed takes THROUGH THE APP, shared by the two that exist.
//
// `seed/accounts.ts` (the four dev accounts) and `shot/account.ts` (the
// account the published screenshots are taken of) are different fixtures with
// different libraries and different reasons to exist, but the middle of both is
// the same three gestures: import a backup, wait for it to reach the server,
// and — when the fixture itself has changed — delete what was there first. They
// live here rather than in either caller so that neither imports the other.
//
// That is not tidiness; it is the repair for a real defect. These two were
// exported from `seed/seed.ts` (now `accounts.ts`), whose top level ran `main()`
// — so importing them from the shot run silently RE-SEEDED all four dev accounts
// before taking a screenshot. Nothing failed: the seed is idempotent, so it
// printed its usual receipts and cost ten minutes and a confusing log. The
// entry-module guard that stopped it is still there, but with the shared steps in
// a module of their own it is now a backstop rather than the only thing holding.
//
// Everything here drives the real controls. The design behind that — E2E
// encryption means there is no database to seed links into, so the only writer
// that can produce them is a signed-in client holding the account's key — is
// docs/e2e.md, _the split down the encryption boundary_.

// A thousand links is ~2,000 metadata blobs plus preview images, all of which
// must land in local R2 before the account is worth handing over — the browser
// profile this runs in is deleted at the end, so anything still sitting in Dexie
// is lost. These are wall-clock budgets for that, not correctness knobs.
const IMPORT_TIMEOUT_MS = 15 * 60 * 1000;
const SYNC_TIMEOUT_MS = 30 * 60 * 1000;

// Import through Settings → Data, the same three clicks a person makes. The file
// input is hidden behind a "Choose a file" button; `setInputFiles` drives it
// directly, which is the one place this is allowed to reach past the UI — a real
// OS file picker cannot be driven at all.
export async function importArchive(page: Page, archivePath: string): Promise<void> {
  console.log(`importing ${archivePath}`);
  await page.goto('/settings/data');
  await page.getByRole('button', { name: /^Import data/ }).click();
  await page.locator('input[type=file]').setInputFiles(archivePath);

  const receipt = page.getByText(/^Imported \d+ link/);
  const failure = page.getByText(/^Import failed:/);
  await expect(receipt.or(failure)).toBeVisible({ timeout: IMPORT_TIMEOUT_MS });
  if (await failure.isVisible()) throw new Error(await failure.innerText());

  console.log((await receipt.innerText()).trim());
}

// Wait for the pending-ops queue to drain to the api.
//
// This is the step it would be easy to skip and fatal to: an import lands in
// Dexie first and pushes in the background, and this profile is deleted when the
// run ends. Close early and the account is real, the plan is granted, and the
// library exists nowhere — signing in on another browser shows an empty account
// with no error to explain it.
//
// The signal is the Data section's own sync row: "N changes waiting to sync"
// while the queue is non-empty, "Last synced …" once a cycle has settled. Reading
// the UI rather than polling the api keeps this honest — it is the same thing a
// person watches — and the Sync now button is the same nudge they would press.
//
// The settled reading has to hold for THREE consecutive polls, and that is the
// part not to simplify away. Both halves can lie for one frame just after the
// navigation below: "Last synced" can still be showing the timestamp of the
// refresh the import itself ran before writing anything, and the pending count is
// a liveQuery that reads 0 until its first result lands. Either alone would let
// this return while the queue is full, which is precisely the failure this
// function exists to prevent — and it would look like a clean run.
const SETTLED_POLLS = 3;

export async function waitForSync(page: Page): Promise<void> {
  await page.goto('/settings/data');

  const pending = page.getByText(/\d+ changes? waiting to sync/);
  const synced = page.getByText(/^Last synced/);
  const syncNow = page.getByRole('button', { name: 'Sync now' });

  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let settled = 0;
  let lastReport = '';
  while (Date.now() < deadline) {
    if ((await synced.isVisible()) && !(await pending.isVisible())) {
      if (++settled >= SETTLED_POLLS) {
        console.log('synced');
        return;
      }
    } else {
      settled = 0;
      if (await pending.isVisible()) {
        const report = (await pending.innerText()).trim();
        if (report !== lastReport) {
          console.log(report);
          lastReport = report;
        }
      }
      // Only offered at rest, so this nudges a queue that has stopped moving and
      // is a no-op mid-cycle. `requestSync` coalesces, so repeating it is safe.
      if (await syncNow.isVisible()) await syncNow.click();
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(
    `sync did not settle within ${SYNC_TIMEOUT_MS / 60_000} minutes — the library may be ` +
      `only partly on the server. Sign in as this user and let it finish, or re-run the seed.`,
  );
}

// Settings → Data → Delete all data, through the checkbox gate and the button it
// arms. Destructive by definition, which is why it is behind a flag and never the
// default — but the account it destroys is a local, throwaway fixture whose
// password is derived from its key, so there is nothing here to lose that
// `npm run shot:account` does not rebuild in the next ten minutes.
export async function deleteAllData(page: Page): Promise<void> {
  await page.goto('/settings/data');
  // Two controls named "Delete all data", one after the other: the Data pane's
  // drill-down ROW (SettingsRow with an `onClick` renders the whole row as a
  // button) and then the destructive button inside the view it opens. They are
  // never on screen together — the view replaces the pane — so the same query
  // run twice is unambiguous each time, and it is what a person's two clicks are.
  await page.getByRole('button', { name: 'Delete all data' }).click();
  await page.getByRole('checkbox', { name: /absolutely sure/ }).click();
  await page.getByRole('button', { name: 'Delete all data' }).click();
  // Both receipts, because an empty account is a legitimate state to run this
  // from — a first `--fresh` run, or a re-run after one that died mid-import.
  // Waiting only for the "deleted N items" half would hang on exactly the case
  // where there was nothing to do.
  await expect(
    page.getByText(/^(All your data has been deleted|There was no data to delete)/),
  ).toBeVisible({ timeout: 5 * 60 * 1000 });
  console.log('deleted all data');
}
