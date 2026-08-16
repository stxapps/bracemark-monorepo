import { expect, type Page } from '@playwright/test';

// Push local writes to the api and wait for the cycle to settle.
//
// The contract runs need this and the plain web specs don't: a web spec asserts
// on what Dexie holds, which is already true the moment Save returns, but a
// contract run's whole claim is that the phone can read what the browser wrote —
// so the encrypted blob has to be in R2 before Maestro starts.
//
// There is no test hook for this and there should not be one; the menu item is
// the same control a user has. `requestSync` coalesces, so the click is safe to
// repeat, and the Sync → Syncing… → Sync transition on the item IS the feedback
// (the menu deliberately stays open for it).
export async function syncAndWait(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^More options/ }).click();

  const item = page.getByRole('menuitem', { name: /^(Sync|Syncing…|Sync failed)/ });
  await item.click();

  // Settled = back to the resting label. "Sync failed — Retry" is a real failure
  // and must not be waited through: a contract run that continued past it would
  // fail on the phone and blame the wrong half.
  await expect(item).toHaveText(/^Sync$/, { timeout: 60_000 });

  await page.keyboard.press('Escape');
}
