import { type BrowserContext, type Locator, type Page } from '@playwright/test';

import { scanHtmlMeta, selectTitleImage } from '@stxapps/shared';

import { profileDir } from '../paths';
import { importArchive, waitForSync } from '../seed/steps';
import { unique } from '../web/fixtures/data';
import { WEB_URL } from '../web/fixtures/env';
import { launchApp } from '../web/fixtures/launch';
import { writePagedLibrary } from '../web/fixtures/library';
import { addLink, displayUrl } from '../web/fixtures/links';
import { grantPlus } from '../web/fixtures/plan';
import { syncAndWait } from '../web/fixtures/sync';
import { expect, test } from './fixtures/app';
import { openExtensionPopup, waitForExtensionSync } from './fixtures/extension';

function controlledPageUrl(label: string): string {
  return `${WEB_URL}/sign-in?extension-e2e=${encodeURIComponent(unique(label))}`;
}

function webRowsFor(page: Page, url: string): Locator {
  return page.locator('[data-index]').filter({ has: page.locator(`a[href="${url}"]`) });
}

async function fillEditor(
  popup: Page,
  values: { list: string; tags: string[]; note: string },
): Promise<void> {
  const list = popup.getByRole('combobox', { name: 'List' });
  await list.click();
  await popup.getByPlaceholder('Search or create lists…').fill(values.list);
  await popup.getByRole('option', { name: `Create “${values.list}”` }).click();
  await expect(list).toContainText(values.list);

  const tags = popup.getByRole('combobox', { name: 'Tags' });
  for (const tag of values.tags) {
    await tags.click();
    await popup.getByPlaceholder('Search or create tags…').fill(tag);
    await popup.getByRole('option', { name: `Create “${tag}”` }).click();
    await expect(popup.getByRole('button', { name: `Remove ${tag}` })).toBeVisible();
    await popup.keyboard.press('Escape');
  }
  await popup.getByRole('textbox', { name: 'Note' }).fill(values.note);
}

async function requestSyncAndWait(popup: Page): Promise<void> {
  await waitForExtensionSync(popup);
  await popup.getByRole('button', { name: /^Synced/ }).click();
  await expect(popup.getByText('Pending changes', { exact: true })).toBeVisible();
  await popup.getByRole('button', { name: 'Sync now' }).click();

  const status = popup.getByText('Status', { exact: true }).locator('..').locator('dd');
  const pending = popup.getByText('Pending changes', { exact: true }).locator('..').locator('dd');
  const lastSync = popup.getByText('Last sync', { exact: true }).locator('..').locator('dd');
  await expect(status).toHaveText('Up to date', { timeout: 60_000 });
  await expect(pending).toHaveText('0', { timeout: 60_000 });
  await expect(lastSync).not.toHaveText('Never');
}

async function moveWebLinkToTrash(page: Page, url: string): Promise<void> {
  const row = webRowsFor(page, url);
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Link options' }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await expect(row).toHaveCount(0);
}

interface SuspendedServiceWorker {
  waitForRestart(): Promise<void>;
  dispose(): Promise<void>;
}

async function suspendServiceWorker(context: BrowserContext): Promise<SuspendedServiceWorker> {
  const worker = context.serviceWorkers()[0];
  const page = context.pages()[0];
  if (!worker || !page) throw new Error('extension service worker is not running');

  // Chromium exposes its ServiceWorker control domain on a page target. The
  // browser target can enumerate the worker, but cannot stop it.
  const session = await context.newCDPSession(page);
  try {
    type Version = { versionId: string; scriptURL: string; runningStatus: string };
    const version = new Promise<Version>((resolve) => {
      session.on('ServiceWorker.workerVersionUpdated', ({ versions }: { versions: Version[] }) => {
        const current = versions.find(
          (candidate) =>
            candidate.scriptURL === worker.url() && candidate.runningStatus === 'running',
        );
        if (current) resolve(current);
      });
    });
    await session.send('ServiceWorker.enable');
    const current = await Promise.race([
      version,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('service worker version was not reported')), 10_000),
      ),
    ]);

    const stopped = new Promise<void>((resolve) => {
      session.on('ServiceWorker.workerVersionUpdated', ({ versions }: { versions: Version[] }) => {
        if (
          versions.some(
            (candidate) =>
              candidate.versionId === current.versionId && candidate.runningStatus === 'stopped',
          )
        ) {
          resolve();
        }
      });
    });
    await session.send('ServiceWorker.stopWorker', { versionId: current.versionId });
    await Promise.race([
      stopped,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('service worker did not stop')), 10_000),
      ),
    ]);

    const restarted = new Promise<void>((resolve) => {
      session.on('ServiceWorker.workerVersionUpdated', ({ versions }: { versions: Version[] }) => {
        if (
          versions.some(
            (candidate) =>
              candidate.versionId === current.versionId && candidate.runningStatus === 'running',
          )
        ) {
          resolve();
        }
      });
    });
    return {
      async waitForRestart() {
        await Promise.race([
          restarted,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('service worker did not restart')), 30_000),
          ),
        ]);
      },
      async dispose() {
        await session.detach();
      },
    };
  } catch (error) {
    await session.detach();
    throw error;
  }
}

test.describe('browser extension', () => {
  test(
    'signing out in options clears the session in the open popup and after restart',
    { tag: ['@EXT-SIGN-OUT-001', '@full', '@online', '@extension', '@destructive'] },
    async ({ extensionApp }) => {
      const url = controlledPageUrl('signout');
      const popup = await extensionApp.signIn(url);
      await waitForExtensionSync(popup);
      const options = await extensionApp.context.newPage();
      await options.goto(`chrome-extension://${extensionApp.extensionId}/options.html`);
      await options.getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(options.getByText('Not signed in', { exact: true })).toBeVisible();
      await expect(options.getByTestId('sign-out-dialog')).toHaveCount(0);
      await expect(popup.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      await extensionApp.restart();
      const reopened = await extensionApp.open(url);
      await expect(reopened.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    },
  );

  test(
    'sign-in survives popup and browser-profile reopen',
    { tag: ['@EXT-AUTH-001', '@smoke', '@online', '@extension'] },
    async ({ extensionApp }) => {
      const url = controlledPageUrl('auth');
      const first = await extensionApp.signIn(url);
      await expect(first.getByText('Save this page')).toBeVisible();
      await first.close();

      const reopened = await extensionApp.open(url);
      await expect(reopened.getByText('Save this page')).toBeVisible();
      await expect(reopened.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
      await reopened.close();

      await extensionApp.restart();
      const afterRestart = await extensionApp.open(url);
      await expect(afterRestart.getByText('Save this page')).toBeVisible();
      await expect(afterRestart.getByRole('button', { name: 'Sign in' })).toHaveCount(0);
    },
  );

  test(
    'save with list, tags, and note reaches the saved state without reopening',
    { tag: ['@EXT-SAVE-001', '@smoke', '@online', '@extension'] },
    async ({ extensionApp, webApp }) => {
      const url = controlledPageUrl('save');
      const list = unique('Extension list');
      const tags = [unique('extension-tag-a'), unique('extension-tag-b')];
      const note = unique('Saved from the extension');
      const popup = await extensionApp.signIn(url);
      await waitForExtensionSync(popup);

      await fillEditor(popup, { list, tags, note });
      await popup.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(popup.getByText('Saved', { exact: true })).toBeVisible();
      await expect(popup.getByText(`In ${list}`)).toBeVisible();

      await requestSyncAndWait(popup);
      await syncAndWait(webApp.page);
      await webApp.page.goto('/links');
      await webApp.page.getByRole('button', { name: list }).click();
      const row = webRowsFor(webApp.page, url);
      await expect(row).toHaveCount(1);
      await row.getByRole('button', { name: 'Link options' }).click();
      await webApp.page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
      const dialog = webApp.page.getByRole('dialog', { name: 'Edit link' });
      await expect(dialog.getByRole('combobox', { name: 'List' })).toContainText(list);
      for (const tag of tags) {
        await expect(dialog.getByRole('button', { name: `Remove ${tag}` })).toBeVisible();
      }
      await expect(dialog.getByRole('textbox', { name: 'Note' })).toHaveValue(note);
    },
  );

  test(
    'an already-saved page opens on the saved state',
    { tag: ['@EXT-SAVED-001', '@full', '@online', '@extension'] },
    async ({ extensionApp, webApp }) => {
      const url = controlledPageUrl('already-saved');
      await addLink(webApp.page, url);
      await syncAndWait(webApp.page);

      const popup = await extensionApp.signIn(url);
      await waitForExtensionSync(popup);
      await expect(popup.getByText('Saved', { exact: true })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    },
  );

  test(
    'a trashed page restores the existing link instead of creating a duplicate',
    { tag: ['@EXT-RESTORE-001', '@full', '@online', '@destructive', '@extension'] },
    async ({ extensionApp, webApp }) => {
      const url = controlledPageUrl('restore');
      await addLink(webApp.page, url);
      await moveWebLinkToTrash(webApp.page, url);
      await syncAndWait(webApp.page);

      const popup = await extensionApp.signIn(url);
      await waitForExtensionSync(popup);
      await expect(popup.getByText('Restore this page')).toBeVisible();
      await popup.getByRole('button', { name: 'Restore', exact: true }).click();
      await expect(popup.getByText('Saved', { exact: true })).toBeVisible();
      await requestSyncAndWait(popup);

      await syncAndWait(webApp.page);
      await webApp.page.goto('/links');
      await expect(webRowsFor(webApp.page, url)).toHaveCount(1);
      await webApp.page.getByRole('button', { name: 'Trash' }).click();
      await expect(webRowsFor(webApp.page, url)).toHaveCount(0);
    },
  );

  test(
    'a non-http browser page renders the unsupported-page state',
    { tag: ['@EXT-BOUNDARY-001', '@full', '@online', '@extension'] },
    async ({ extensionApp }) => {
      const signedIn = await extensionApp.signIn(controlledPageUrl('boundary-auth'));
      await signedIn.close();

      const popup = await extensionApp.open('chrome://extensions/');
      await expect(popup.getByText('Nothing to save here')).toBeVisible();
      await expect(popup.getByText(/Open an http or https page/)).toBeVisible();
    },
  );

  test(
    'a web write appears after a sync requested from the open popup',
    { tag: ['@EXT-SYNC-001', '@full', '@online', '@extension'] },
    async ({ extensionApp, webApp }) => {
      const url = controlledPageUrl('web-to-extension');
      const popup = await extensionApp.signIn(url);
      await waitForExtensionSync(popup);

      await addLink(webApp.page, url);
      await syncAndWait(webApp.page);
      await requestSyncAndWait(popup);
      await popup.getByRole('button', { name: 'Back' }).click();
      await expect(popup.getByText('Saved', { exact: true })).toBeVisible();
    },
  );

  test(
    'an extension write appears in a separate web profile after sync',
    { tag: ['@EXT-SYNC-002', '@full', '@online', '@extension'] },
    async ({ extensionApp, webApp }, testInfo) => {
      const url = controlledPageUrl('extension-to-web');
      const popup = await extensionApp.signIn(url);
      await waitForExtensionSync(popup);
      await popup.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(popup.getByText('Saved', { exact: true })).toBeVisible();
      await requestSyncAndWait(popup);

      const reader = await launchApp(
        profileDir(`extension-reader-w${testInfo.workerIndex}-${unique('sync')}`),
        { existing: webApp.credentials },
      );
      try {
        await expect(reader.page.getByText(displayUrl(url))).toBeVisible({ timeout: 90_000 });
      } finally {
        await reader.close();
      }
    },
  );

  test(
    'active-page title and image extraction reaches a separate web profile',
    { tag: ['@EXT-EXTRACT-001', '@full', '@online', '@extension'] },
    async ({ extensionApp, webApp }, testInfo) => {
      const url = controlledPageUrl('extraction');
      const title = unique('Controlled extension title');
      const firstPopup = await extensionApp.signIn(url);
      await waitForExtensionSync(firstPopup);
      await firstPopup.close();

      await extensionApp.subject.evaluate(
        ({ extractedTitle, image }) => {
          document.title = extractedTitle;
          const titleMeta =
            document.querySelector<HTMLMetaElement>('meta[property="og:title"]') ??
            document.head.appendChild(document.createElement('meta'));
          titleMeta.setAttribute('property', 'og:title');
          titleMeta.setAttribute('content', extractedTitle);

          const imageMeta =
            document.querySelector<HTMLMetaElement>('meta[property="og:image"]') ??
            document.head.appendChild(document.createElement('meta'));
          imageMeta.setAttribute('property', 'og:image');
          imageMeta.setAttribute('content', image);
        },
        { extractedTitle: title, image: `${WEB_URL}/logo512.png` },
      );
      const popup = await openExtensionPopup(
        extensionApp.context,
        extensionApp.extensionId,
        extensionApp.subject,
      );
      await popup.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(popup.getByText('Saved', { exact: true })).toBeVisible();
      await expect(popup.locator('.h-10.w-16 img[src^="blob:"]')).toBeVisible({
        timeout: 60_000,
      });
      await requestSyncAndWait(popup);

      const reader = await launchApp(
        profileDir(`extension-reader-w${testInfo.workerIndex}-${unique('extract')}`),
        { existing: webApp.credentials },
      );
      try {
        const row = webRowsFor(reader.page, url);
        await expect(row).toHaveCount(1, { timeout: 90_000 });
        await expect(row.getByText(title, { exact: true })).toBeVisible();
        await expect(row.locator('img.object-cover')).toBeVisible({ timeout: 60_000 });
      } finally {
        await reader.close();
      }
    },
  );

  // A tab that moved in place (`pushState`) still carries the head it was LOADED with
  // (docs/link-extraction-keep.md, _⚠ a page moved in place_). The collector must see
  // that, read the new address again and take ITS tags. The subject is bracemark-web's
  // sign-in page, whose server head names the app (og:title, og:image, an og:url that is
  // never the page), so the right answer is the server's. What only a real browser
  // proves: Chrome's `executeScript` handing back the collector's PROMISE, and the
  // page's own re-read.
  test(
    'a save after an in-page move takes the new address’s tags, not the stale head’s',
    { tag: ['@EXT-EXTRACT-002', '@full', '@online', '@extension'] },
    async ({ extensionApp, webApp }, testInfo) => {
      const loadedUrl = controlledPageUrl('moved-from');
      const movedUrl = controlledPageUrl('moved-to');
      const staleTitle = unique('Stale head title');
      const movedTitle = unique('Moved page title');
      const firstPopup = await extensionApp.signIn(loadedUrl);
      await waitForExtensionSync(firstPopup);
      await firstPopup.close();

      // The head the page loaded with, then the move: a new address and a new <title>,
      // and nothing else rewritten — YouTube's shape.
      await extensionApp.subject.evaluate(
        ({ stale, image, to, title }) => {
          for (const [property, content] of [
            ['og:title', stale],
            ['og:image', image],
          ]) {
            const meta =
              document.querySelector<HTMLMetaElement>(`meta[property="${property}"]`) ??
              document.head.appendChild(document.createElement('meta'));
            meta.setAttribute('property', property);
            meta.setAttribute('content', content);
          }
          history.pushState({}, '', to);
          document.title = title;
        },
        { stale: staleTitle, image: `${WEB_URL}/logo512.png`, to: movedUrl, title: movedTitle },
      );
      await expect(extensionApp.subject).toHaveURL(movedUrl);

      // What the re-read should find: the server's answer for the new address, chosen the
      // way the background chooses (selectTitleImage), over the live <title>.
      const served = await (await fetch(movedUrl)).text();
      const expected = selectTitleImage(
        {
          ...scanHtmlMeta(served, { maxChars: 3 * 1024 * 1024, through: 'document' }),
          docTitle: movedTitle,
        },
        new URL(movedUrl),
      ).title;
      expect(expected).toBeTruthy();
      expect(expected).not.toBe(staleTitle);

      const popup = await openExtensionPopup(
        extensionApp.context,
        extensionApp.extensionId,
        extensionApp.subject,
      );
      await popup.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(popup.getByText('Saved', { exact: true })).toBeVisible();
      await requestSyncAndWait(popup);

      const reader = await launchApp(
        profileDir(`extension-reader-w${testInfo.workerIndex}-${unique('moved')}`),
        { existing: webApp.credentials },
      );
      try {
        const row = webRowsFor(reader.page, movedUrl);
        await expect(row).toHaveCount(1, { timeout: 90_000 });
        await expect(row.getByText(expected as string, { exact: true })).toBeVisible({
          timeout: 60_000,
        });
        await expect(row.getByText(staleTitle)).toHaveCount(0);
      } finally {
        await reader.close();
      }
    },
  );

  // The one client that takes both kept copies, taking them from a real page and
  // handing them to the web reader (docs/link-extraction-keep.md, _per client_). The
  // reader's tabs and layout are READER-WEB-001's, over copies a backup brings; this
  // is the capture: Readability and the walker over a live DOM, captureVisibleTab,
  // both encrypted and pushed, and read back by another profile.
  test(
    'a Plus save keeps a read-mode copy and a screenshot that a separate web profile reads',
    { tag: ['@EXT-KEEP-001', '@full', '@online', '@extension'] },
    async ({ extensionApp, webApp }, testInfo) => {
      // Kept copies are Plus. Granted before the popup first asks for the plan.
      await grantPlus(webApp.credentials.username);
      const url = controlledPageUrl('keep');
      const heading = unique('Kept article heading');
      const sentence = unique('A sentence only the kept copy carries');
      const firstPopup = await extensionApp.signIn(url);
      await waitForExtensionSync(firstPopup);
      await firstPopup.close();

      // The controlled page becomes an article Readability takes: a heading and
      // paragraphs long enough to pass its pre-check, in place of the sign-in form.
      await extensionApp.subject.evaluate(
        ({ articleHeading, articleSentence }) => {
          const filler =
            'Paragraph text long enough that a reader view scores it as the body of an ' +
            'article rather than the chrome around one, with commas, and full sentences.';
          document.title = articleHeading;
          document.body.innerHTML =
            `<main><article><h1>${articleHeading}</h1>` +
            `<p>${articleSentence}. ${filler}</p>` +
            [1, 2, 3, 4].map(() => `<p>${filler} ${filler}</p>`).join('') +
            '</article></main>';
        },
        { articleHeading: heading, articleSentence: sentence },
      );

      const popup = await openExtensionPopup(
        extensionApp.context,
        extensionApp.extensionId,
        extensionApp.subject,
      );
      // The plan settles before the save reads it (IAP-ENTITLEMENT-001 has why).
      await waitForExtensionSync(popup);
      await popup.waitForFunction(() => {
        const raw = localStorage.getItem('bracemark.subscriptionStatus');
        return raw !== null && (JSON.parse(raw) as { plan?: string }).plan === 'plus';
      });

      // The save asks for read mode by itself (the default `keepReadModeOnSave`); the
      // screenshot is a tap on the saved screen.
      await popup.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(popup.getByText('Saved', { exact: true })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Read mode kept — read it' })).toBeVisible({
        timeout: 60_000,
      });
      await popup.getByRole('button', { name: 'Screenshot', exact: true }).click();
      await expect(popup.getByRole('button', { name: 'Screenshot kept — read it' })).toBeVisible({
        timeout: 60_000,
      });
      await requestSyncAndWait(popup);

      const reader = await launchApp(
        profileDir(`extension-reader-w${testInfo.workerIndex}-${unique('keep')}`),
        { existing: webApp.credentials },
      );
      try {
        const { page } = reader;
        const row = webRowsFor(page, url);
        await expect(row).toHaveCount(1, { timeout: 90_000 });
        await row.getByRole('button', { name: 'Link options' }).click();
        await page.getByRole('menuitem', { name: 'Read', exact: true }).click();
        await expect(page.getByRole('tab', { name: 'Read mode', exact: true })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        // The sentence is the copy's own: the heading is also the page title, which
        // the link's row and the reader's title carry without any copy at all.
        await expect(page.getByText(sentence, { exact: false })).toBeVisible({ timeout: 30_000 });

        await page.getByRole('tab', { name: 'Screenshot', exact: true }).click();
        const image = page.getByRole('img', { name: /^Screenshot of .*, as it looked when/ });
        await expect(image).toBeVisible({ timeout: 30_000 });
        await expect
          .poll(() =>
            image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
          )
          .toBe(true);
      } finally {
        await reader.close();
      }
    },
  );

  test(
    'a sync request wakes a terminated MV3 service worker',
    { tag: ['@EXT-SERVICE-WORKER-001', '@full', '@online', '@extension'] },
    async ({ extensionApp, webApp }) => {
      const url = controlledPageUrl('worker-restart');
      const popup = await extensionApp.signIn(url);
      await waitForExtensionSync(popup);
      await popup.close();

      await addLink(webApp.page, url);
      await syncAndWait(webApp.page);

      const suspended = await suspendServiceWorker(extensionApp.context);
      try {
        const afterRestart = await extensionApp.open(url);
        await requestSyncAndWait(afterRestart);
        await suspended.waitForRestart();
        await afterRestart.getByRole('button', { name: 'Back' }).click();
        await expect(afterRestart.getByText('Saved', { exact: true })).toBeVisible({
          timeout: 90_000,
        });
      } finally {
        await suspended.dispose();
      }
    },
  );

  // The browser extension's one plan gate is the free tier's link cap: at 200 the
  // popup replaces its editor with the full-library wall, and upgrading is a
  // hand-off to the web app (popup/Editor.tsx). The popup is a fresh document
  // on every open, so reopening it is its whole "refresh" — it re-asks
  // `GET /v1/iap/status` and folds the answer over its cached copy.
  test(
    'a manual Plus grant lifts the full-library wall when the popup next opens',
    { tag: ['@IAP-ENTITLEMENT-001', '@full', '@online', '@extension', '@scale'] },
    async ({ extensionApp, webApp }, testInfo) => {
      const library = await writePagedLibrary(testInfo.outputPath('at-cap.zip'), {
        count: 200,
        label: 'e2e-ext-cap',
      });
      await importArchive(webApp.page, library.archivePath);
      await waitForSync(webApp.page);

      // --- free, at the cap: the wall, and its way out -------------------------
      const url = controlledPageUrl('plan-gate');
      const atCap = await extensionApp.signIn(url);
      await waitForExtensionSync(atCap);
      await expect(atCap.getByRole('heading', { name: 'Your library is full' })).toBeVisible();
      await expect(atCap.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
      const [plans] = await Promise.all([
        extensionApp.context.waitForEvent('page'),
        atCap.getByRole('button', { name: 'Upgrade to Plus' }).click(),
      ]);
      await expect(plans).toHaveURL(`${WEB_URL}/settings/subscription`);
      await plans.close();
      await atCap.close();

      // --- the grant; the next open knows it -----------------------------------
      await grantPlus(webApp.credentials.username);
      const opened = await extensionApp.open(url);
      // Read only once BOTH inputs to the gate have settled, or the editor can be
      // caught in the frame before the link count loads — which a popup still
      // walled off would also show. The count is settled with the synced pill;
      // the plan once the popup has persisted the fresh answer as its last-known
      // copy, which web-react's useEntitlements does only after rendering it
      // (web/fixtures/plan.ts, awaitPlus, reads the same key for the same
      // reason).
      await waitForExtensionSync(opened);
      await opened.waitForFunction(() => {
        const raw = localStorage.getItem('bracemark.subscriptionStatus');
        return raw !== null && (JSON.parse(raw) as { plan?: string }).plan === 'plus';
      });
      await expect(opened.getByRole('heading', { name: 'Your library is full' })).toHaveCount(0);
      await expect(opened.getByRole('heading', { name: 'Save this page' })).toBeVisible();
      // The 201st link: the wall was the cap, and nothing behind it counts.
      await opened.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(opened.getByText('Saved', { exact: true })).toBeVisible();
    },
  );
});
