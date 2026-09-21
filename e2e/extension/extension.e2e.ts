import { type BrowserContext, type Locator, type Page } from '@playwright/test';

import { profileDir } from '../paths';
import { unique } from '../web/fixtures/data';
import { WEB_URL } from '../web/fixtures/env';
import { launchApp } from '../web/fixtures/launch';
import { addLink, displayUrl } from '../web/fixtures/links';
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
});
