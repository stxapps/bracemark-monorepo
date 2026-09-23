import { type BrowserContext } from '@playwright/test';

// Keep bracemark-web's local store busy from a SECOND TAB of the same origin, so
// the links page's first read genuinely waits — the lever SKELETON-WEB-001 uses
// to put the first-read skeleton on screen for as long as it takes to measure.
//
// It is contention, not a substitute: IndexedDB will not start a read-only
// transaction over a store while an earlier read-write transaction on that store
// is still running, so the app's own `readLinks` (Dexie, unmodified, in the app's
// own tab) sits queued behind this one exactly as it would behind a long import
// in another tab. Nothing in the app is replaced, stubbed or slowed, and nothing
// is written — the held transaction only counts. The alternative the verify
// skill describes, CPU throttling, stretches the same frames but catches them by
// timing; this one holds them until the spec lets go.
//
// The names are the store's schema — `bracemark-data` and its `items` table
// (packages/web-react/src/data/db.ts) — the same kind of addressing as a sync
// path. Scoped to `items` alone on purpose: the session (its own database), the
// first-sync flag (`syncMeta`) and the device settings (`localSettings`) stay
// readable, so the app shell comes up and only the reads of synced entities wait.

export interface StoreHold {
  release(): Promise<void>;
}

interface HoldWindow {
  __e2eReleaseItems?: () => void;
}

export async function holdItemsStore(context: BrowserContext): Promise<StoreHold> {
  const page = await context.newPage();
  // Same origin, and no app on it: a static asset the web server answers.
  await page.goto('/manifest.json');
  // Resolves once the transaction's first request has succeeded — from then on
  // it is active and holds the store — and keeps it active by issuing the next
  // request from each success until released. A transaction commits as soon as
  // it has nothing pending at the end of a task, so the chain is what holds it.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('bracemark-data');
        open.onerror = () => reject(open.error ?? new Error('indexedDB.open failed'));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('items', 'readwrite');
          const store = tx.objectStore('items');
          let released = false;
          (window as HoldWindow).__e2eReleaseItems = () => {
            released = true;
          };
          const spin = () => {
            if (!released) store.count().onsuccess = spin;
          };
          tx.oncomplete = () => db.close();
          tx.onerror = () => reject(tx.error ?? new Error('hold transaction failed'));
          store.count().onsuccess = () => {
            resolve();
            spin();
          };
        };
      }),
  );
  return {
    async release() {
      await page.evaluate(() => (window as HoldWindow).__e2eReleaseItems?.());
      await page.close();
    },
  };
}
