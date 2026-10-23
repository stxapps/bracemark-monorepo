import { type BrowserContext } from '@playwright/test';

import { profileDir } from '../paths';
import { expect, test } from './fixtures/app';
import { unique, unresolvableUrl } from './fixtures/data';
import { API_URL, WEB_URL } from './fixtures/env';
import { exportPlainTextOffline } from './fixtures/export';
import { launchApp } from './fixtures/launch';
import {
  addLink,
  addLinkButton,
  chooseRowMenuItem,
  linkRow,
  openSidebarItem,
} from './fixtures/links';
import { countPendingOps, syncAndWait } from './fixtures/sync';

// Local-first with the network gone, on a page that stays open: the library is
// read from IndexedDB, a new link and an edit are written there and queued, and
// the queue drains by itself once the network is back — to a SECOND profile,
// since seeing a local write on the writer is not a sync claim. The engine's
// queue and reconcile are unit-tested; what only a browser shows is that the
// mounted app keeps working through `fetch` failing underneath it, says so, and
// recovers without a reload or a press (docs/local-first-sync.md, _the three
// flows_).
//
// `context.setOffline` cuts the browser off at the network layer — every fetch
// fails as it would with the Wi-Fi off. The dev server has no service worker, so
// a reload or a hard navigation would fail too; that half is the PWA target's
// (pwa/pwa.e2e.ts).

test.describe('offline', () => {
  test(
    'an open page reads, writes and edits offline, then syncs the queue to another profile',
    { tag: ['@OFFLINE-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp }, testInfo) => {
      // Two Argon2id ceremonies and a failed cycle's retries.
      test.setTimeout(4 * 60 * 1000);
      const { context, page, credentials } = isolatedApp;
      const edited = unresolvableUrl(unique('offline-edited'));
      const kept = unresolvableUrl(unique('offline-kept'));
      const added = unresolvableUrl(unique('offline-added'));
      const title = unique('E2E offline title');

      await page.goto('/links');
      await addLink(page, kept);
      await addLink(page, edited);
      await syncAndWait(page);

      await context.setOffline(true);
      try {
        // --- read: the cached library, through in-app navigation --------------------
        await openSidebarItem(page, 'Show All');
        await expect(linkRow(page, kept)).toBeVisible();
        await openSidebarItem(page, 'My List');
        await expect(linkRow(page, edited)).toBeVisible();

        // --- write: a new link and an edit, both local ------------------------------
        await addLink(page, added);
        await chooseRowMenuItem(page, edited, 'Edit');
        const dialog = page.getByRole('dialog', { name: 'Edit link' });
        await dialog.getByRole('textbox', { name: 'Title' }).fill(title);
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(linkRow(page, edited)).toContainText(title);

        // The writes' own sync attempt failed, and the chrome says so rather than
        // spinning or saying nothing.
        await expect(page.getByRole('button', { name: 'More options (sync failed)' })).toBeVisible({
          timeout: 60_000,
        });
        await testInfo.attach('offline-web-queued', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      } finally {
        await context.setOffline(false);
      }

      // --- reconnect: the queue drains with nobody pressing anything ------------------
      // The failed cycle left a retry scheduled, and coming back online starts it
      // at once (docs/local-first-sync.md, _retrying a failure_, L3). Nothing else
      // runs a cycle on a mounted page that nobody touches, so a queue that drains
      // here drained by that retry; before it, it waited for a press of Sync.
      // The queue is the claim, not the label: the ⋯ button reads plain "More
      // options" while a cycle is still running, too.
      await expect
        .poll(() => countPendingOps(page), {
          message: 'the queue did not drain on its own after reconnecting',
          timeout: 60_000,
        })
        .toBe(0);
      await expect(page.getByRole('button', { name: 'More options', exact: true })).toBeVisible();

      const reader = await launchApp(profileDir(`offline-reader-w${testInfo.workerIndex}`), {
        existing: credentials,
      });
      try {
        await reader.page.goto('/links');
        await syncAndWait(reader.page);
        await expect(linkRow(reader.page, added)).toHaveCount(1);
        await expect(linkRow(reader.page, edited)).toContainText(title);
        await expect(linkRow(reader.page, kept)).toHaveCount(1);
      } finally {
        await reader.close();
      }
    },
  );

  test(
    'an open Data page exports the local library, a write made offline in another tab included',
    { tag: ['@OFFLINE-EXPORT-WEB-001', '@full', '@online'] },
    async ({ isolatedApp }) => {
      test.setTimeout(3 * 60 * 1000);
      const { context, page } = isolatedApp;
      const synced = unresolvableUrl(unique('offline-export-synced'));
      const added = unresolvableUrl(unique('offline-export-added'));

      await page.goto('/links');
      await addLink(page, synced);
      await syncAndWait(page);
      // Both pages are open BEFORE the network goes. Without a service worker —
      // and a browser tab has none (inner-layout.tsx registers it only when
      // installed) — an in-app move to Settings while offline has no route payload
      // to fetch, and Next falls back to a document load that lands on Chrome's
      // error page. The installed app's worker is what makes that route work
      // offline, and PWA-003 owns it; this case owns the export itself.
      const data = await context.newPage();
      await data.goto('/settings/data');

      await context.setOffline(true);
      try {
        await addLink(page, added);
        // The export reads the local store, which the other tab has just written
        // and never pushed: the offline write is in the file.
        const text = await exportPlainTextOffline(data);
        expect(text).toContain(synced);
        expect(text).toContain(added);
      } finally {
        await context.setOffline(false);
      }
    },
  );

  test(
    'with the api answering 500 and then 404, the app stays signed in, reads, writes, reloads and exports, then drains to another profile',
    { tag: ['@OFFLINE-API-ERROR-WEB-001', '@full', '@online', '@destructive'] },
    async ({ isolatedApp }, testInfo) => {
      // Two Argon2id ceremonies and every call's retries against a 500.
      test.setTimeout(5 * 60 * 1000);
      const { context, page, credentials } = isolatedApp;
      const edited = unresolvableUrl(unique('api-error-edited'));
      const kept = unresolvableUrl(unique('api-error-kept'));
      const added = unresolvableUrl(unique('api-error-added'));
      const title = unique('E2E api error title');

      await page.goto('/links');
      await addLink(page, kept);
      await addLink(page, edited);
      await syncAndWait(page);

      // The server that is gone but still answers: a crashed Worker (500), or a
      // route that no longer exists (404). Only the api — the web origin still
      // serves, so unlike the offline case above a reload is possible here, and
      // it is the claim that matters most: a boot that read either status as
      // "signed out" would wipe the library it could no longer re-download.
      try {
        await answerApiWith(context, 500);
        await openSidebarItem(page, 'Show All');
        await expect(linkRow(page, kept)).toBeVisible();

        await addLink(page, added);
        await chooseRowMenuItem(page, edited, 'Edit');
        const dialog = page.getByRole('dialog', { name: 'Edit link' });
        await dialog.getByRole('textbox', { name: 'Title' }).fill(title);
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'More options (sync failed)' })).toBeVisible({
          timeout: 90_000,
        });

        await answerApiWith(context, 404);
        await page.reload();
        await expect(addLinkButton(page)).toBeVisible();
        await openSidebarItem(page, 'Show All');
        await expect(linkRow(page, added)).toBeVisible();
        await expect(linkRow(page, edited)).toContainText(title);

        await page.goto('/settings/data');
        const text = await exportPlainTextOffline(page);
        expect(text).toContain(kept);
        expect(text).toContain(added);
        expect(text).toContain(edited);
        await testInfo.attach('api-error-exported', {
          body: await page.screenshot(),
          contentType: 'image/png',
        });
      } finally {
        await context.unrouteAll({ behavior: 'ignoreErrors' });
      }

      // --- the api returns: the queue made under both statuses drains ---------------
      await page.goto('/links');
      await syncAndWait(page);

      const reader = await launchApp(profileDir(`api-error-reader-w${testInfo.workerIndex}`), {
        existing: credentials,
      });
      try {
        await reader.page.goto('/links');
        await syncAndWait(reader.page);
        await expect(linkRow(reader.page, added)).toHaveCount(1);
        await expect(linkRow(reader.page, edited)).toContainText(title);
        await expect(linkRow(reader.page, kept)).toHaveCount(1);
      } finally {
        await reader.close();
      }
    },
  );
});

// Answer every request to the api with `status`, replacing whatever answered
// before. With CORS headers, deliberately: without them the browser refuses the
// cross-origin response and the app sees a network error — the offline case
// again, not a server that answers wrongly. The bearer header makes every
// authenticated call preflighted, so OPTIONS is allowed through as the real api
// would allow it.
async function answerApiWith(context: BrowserContext, status: number): Promise<void> {
  await context.unrouteAll({ behavior: 'wait' });
  const cors = {
    'access-control-allow-origin': WEB_URL,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  };
  await context.route(`${API_URL}/**`, (route) =>
    route.request().method() === 'OPTIONS'
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status, headers: cors, contentType: 'text/plain', body: `${status}` }),
  );
}
