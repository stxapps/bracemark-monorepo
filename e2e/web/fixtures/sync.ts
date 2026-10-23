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
//
// `timeoutMs` is for a cycle that genuinely moves a lot of bytes (the capacity
// case's 110 MiB); the default suits every metadata-sized push.
export async function syncAndWait(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.getByRole('button', { name: /^More options/ }).click();

  const item = page.getByRole('menuitem', { name: /^(Sync|Syncing…|Sync failed)/ });
  await item.click();

  // Settled = back to the resting label. "Sync failed — Retry" is a real failure
  // and must not be waited through: a contract run that continued past it would
  // fail on the phone and blame the wrong half. So the wait ends on EITHER
  // settled label and the resting one is asserted after, which fails a broken
  // cycle at once instead of at the end of a long budget.
  await expect(item).toHaveText(/^(Sync|Sync failed.*)$/, { timeout: timeoutMs });
  await expect(item).toHaveText(/^Sync$/, { timeout: 1_000 });

  await page.keyboard.press('Escape');
}

// How many edits are waiting to push — the `pendingOps` table alone, read
// straight off the store by its schema names (web-react data/db.ts).
export async function countPendingOps(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('bracemark-data');
        open.onerror = () => reject(open.error ?? new Error('indexedDB.open failed'));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('pendingOps', 'readonly');
          const count = tx.objectStore('pendingOps').count();
          tx.oncomplete = () => {
            db.close();
            resolve(count.result);
          };
          tx.onerror = () => reject(tx.error ?? new Error('count transaction failed'));
        };
      }),
  );
}
