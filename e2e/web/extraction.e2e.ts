import { type Page } from '@playwright/test';

import { IS_STAGING } from '../runner/environment';
import { expect, test } from './fixtures/app';
import { EXTRACTOR_URL } from './fixtures/env';
import { knownPage, writePendingExtractionLibrary } from './fixtures/extraction';
import { addLinkButton, displayUrl, linkRow } from './fixtures/links';
import { grantPlusAndLoad } from './fixtures/plan';

// Server extraction, end to end: bracemark-web orchestrating the REAL local
// bracemark-extractor, which fetches a REAL public page. These are the only web
// cases allowed to assert on an extracted value, and they pay for it with the
// `internet` trait — `--exclude-trait internet` leaves an offline run whole.
//
// What each one owns that no unit spec can see: the opt-in reaching the
// provider through a real Switch and a real Plus entitlement, the drain waking
// on a mounted list, the write-back landing in Dexie and repainting the row
// without a reload, and the Generate all job walking rows nobody has displayed.
// The parse, the select rule and the verdict table are already proved against
// the real HTMLRewriter (apps/bracemark-extractor) and in shared.
//
// The public page is example.com (web/fixtures/extraction.ts says why, and what
// that choice leaves unproved — no image, no redirect).
//
// The first two also run against STAGING, where they are the only journeys that
// put server extraction under the deployed CSP and through the deployed
// extractor Worker — the origin baked into the shipped bundle, its real
// preflight, a fetch from Cloudflare's network rather than a laptop's. They get
// their plan the way they do locally, the row landing in staging's remote D1
// (seed/plan.ts; the registry's `stagingGrants` is what admits that write). The
// offline case stays local: it aborts the extractor at the browser's network
// boundary, which says nothing a deployed tier could change.
test.describe('server extraction', () => {
  // Each case builds a Plus account (Argon2id) and then waits on a real fetch.
  test.describe.configure({ timeout: 4 * 60 * 1000 });

  // Global setup requires the extractor beside the api and the web app
  // (global-setup.ts), so locally this is a backstop — for a config that does
  // not require that leg. A missing extractor would otherwise present as a
  // row that simply never acquires its title — indistinguishable from the bug
  // these cases exist to catch — so say it up front instead. (On staging nothing
  // local is required, and the same check reads as an undeployed Worker.)
  test.beforeAll(async () => {
    const health = await fetch(`${EXTRACTOR_URL}/health`).catch(() => null);
    if (!health?.ok) {
      throw new Error(
        `bracemark-extractor is not answering on ${EXTRACTOR_URL}. ` +
          (IS_STAGING
            ? 'Deploy it with `npm run deploy:extractor:staging`'
            : 'Run `npm run dev` (it starts api, web and extractor)') +
          ' or exclude these cases with `--exclude-trait internet`.',
      );
    }
  });

  test(
    'a save fills in its title from the server extractor without a reload',
    { tag: ['@EXTRACT-WEB-001', '@full', '@online', '@internet'] },
    async ({ isolatedApp: app }) => {
      const { page } = app;
      const known = knownPage('e2e-web-save');

      await grantPlusAndLoad(page, app.credentials.username);
      await enableServerExtraction(page);
      await page.goto('/links');

      // The fetch is the extractor's, not the page's: a web tab cannot read
      // example.com at all (CORS), so the title can only come back this way.
      const extracted = page.waitForResponse(
        (response) =>
          response.url() === `${EXTRACTOR_URL}/v1/extract` &&
          response.request().method() === 'POST',
      );
      await saveThroughQuickAdd(page, known.url);

      // The save is committed first — the row exists — and the title follows it
      // asynchronously into the SAME mounted row.
      const row = linkRow(page, known.url);
      await expect(row).toHaveCount(1);
      expect((await extracted).ok()).toBe(true);
      await expect(row.getByText(known.title, { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(row.getByText(displayUrl(known.url), { exact: true })).toHaveCount(0);

      // And it was written, not merely rendered: a fresh document reads it back.
      await page.reload();
      await expect(linkRow(page, known.url).getByText(known.title, { exact: true })).toBeVisible();
    },
  );

  test(
    'Generate all drains an imported pending library and settles each verdict',
    { tag: ['@EXTRACT-WEB-ALL-001', '@full', '@online', '@internet'] },
    async ({ isolatedApp: app }, testInfo) => {
      const { page } = app;
      const library = await writePendingExtractionLibrary(
        testInfo.outputPath('pending-extraction.zip'),
        { label: 'e2e-web-all' },
      );

      await grantPlusAndLoad(page, app.credentials.username);

      // Import through the real file surface, then go STRAIGHT to the extraction
      // settings. The links list is never rendered in this document, so the
      // displayed-scoped automatic drain has nothing in scope: any row that
      // settles below was reached by the Generate all job and nothing else.
      await page.goto('/settings/data');
      await page.getByRole('button', { name: /^Import data/ }).click();
      await page.locator('input[type=file]').setInputFiles(library.archivePath);
      await expect(page.getByText(/^Imported 3 links\./)).toBeVisible({ timeout: 60_000 });

      await enableServerExtraction(page);
      await expect(page.getByText('0 of 3 links previewed.', { exact: true })).toBeVisible();
      await expect(stat(page, 'Pending')).toHaveText(/^3\s*Pending$/);

      // The two-step confirm names the job's size before it bills anything.
      await page.getByRole('button', { name: 'Generate all' }).click();
      const question = page.getByRole('group', { name: /Generate previews for all 3 pending/ });
      await expect(question).toBeVisible();
      await question.getByRole('button', { name: 'Confirm' }).click();

      // Settled = every row has a verdict and the finite job has ended. Each
      // bucket is asserted on its own because the progress line alone cannot
      // tell a transient failure from a permanent one.
      await expect(page.getByText('1 of 3 links previewed.', { exact: true })).toBeVisible({
        timeout: 90_000,
      });
      await expect(stat(page, 'With preview')).toHaveText(/^1\s*With preview$/);
      await expect(stat(page, 'Pending')).toHaveText(/^0\s*Pending$/);
      await expect(stat(page, 'Will retry')).toHaveText(/^1\s*Will retry$/);
      await expect(stat(page, 'Won’t retry')).toHaveText(/^1\s*Won’t retry$/);
      await expect(page.getByRole('button', { name: 'Generate all' })).toBeDisabled();

      // The representative rows: the extracted title on the success, and the
      // typed-URL fallback on both failures — a failure never invents a title.
      await page.goto('/links');
      await expect(
        linkRow(page, library.known.url).getByText(library.known.title, { exact: true }),
      ).toBeVisible();
      for (const failed of [library.missing, library.unreachable]) {
        await expect(
          linkRow(page, failed.url).getByText(displayUrl(failed.url), { exact: true }),
        ).toBeVisible();
      }
    },
  );

  test(
    'a save stays successful and pending while extraction is down, then enriches',
    { tag: ['@EXTRACT-OFFLINE-001', '@full', '@online', '@internet'] },
    async ({ isolatedApp: app }) => {
      const { page, context } = app;
      const known = knownPage('e2e-web-offline');

      await grantPlusAndLoad(page, app.credentials.username);
      await enableServerExtraction(page);

      // Extraction unavailable, and ONLY extraction: the api stays reachable, so
      // the save still commits and syncs. Aborting at the network boundary is the
      // same failure a down extractor or a dropped connection hands the drain — a
      // transport error, which it must answer with a backed-off retry rather than
      // a per-link verdict.
      let refused = 0;
      const extractor = `${EXTRACTOR_URL}/**`;
      await context.route(extractor, (route) => {
        if (route.request().method() === 'POST') refused++;
        return route.abort('internetdisconnected');
      });

      await page.goto('/links');
      await saveThroughQuickAdd(page, known.url);
      const row = linkRow(page, known.url);
      await expect(row.getByText(displayUrl(known.url), { exact: true })).toBeVisible();
      await expect.poll(() => refused, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);

      // Still saved, still pending across a fresh document — and the new
      // provider tries again rather than having recorded a verdict.
      await page.reload();
      const afterReload = refused;
      await expect(row.getByText(displayUrl(known.url), { exact: true })).toBeVisible();
      await expect.poll(() => refused, { timeout: 30_000 }).toBeGreaterThanOrEqual(afterReload + 2);
      await expect(row.getByText(known.title, { exact: true })).toHaveCount(0);

      // Restore it. Nothing is pressed and nothing reloads: the drain's own
      // backed-off retry is what has to find the extractor again.
      await context.unroute(extractor);
      await expect(row.getByText(known.title, { exact: true })).toBeVisible({ timeout: 60_000 });
    },
  );
});

// The privacy-load-bearing opt-in, through the real Switch. On a client that did
// not receive the Plus grant this section renders "Upgrade to Plus" instead, so
// the missing switch fails here rather than as a title that never arrives.
async function enableServerExtraction(page: Page): Promise<void> {
  await page.goto('/settings/extraction');
  const toggle = page.getByRole('switch', { name: 'Server previews' });
  await expect(toggle).toHaveAttribute('data-state', 'unchecked');
  await toggle.click();
  await expect(toggle).toHaveAttribute('data-state', 'checked');
}

// Quick-add without `addLink`'s fallback assertion: here the fallback is a
// transient state that the case's subject replaces, sometimes within a frame.
async function saveThroughQuickAdd(page: Page, url: string): Promise<void> {
  await addLinkButton(page).click();
  await page.locator('#link-url').fill(url);
  await page.getByRole('button', { name: /^(Save|Confirm)$/ }).click();
  await expect(page.locator('#link-url')).toHaveCount(0);
}

// One of the section's four count tiles, by its label. The tile's text is the
// number followed by the label, so a whole-text match pins both.
function stat(page: Page, label: string) {
  return page.getByText(label, { exact: true }).locator('xpath=..');
}
