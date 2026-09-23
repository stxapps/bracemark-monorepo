import { mkdir, rm } from 'node:fs/promises';

import { type BrowserContext, chromium, expect, type Page } from '@playwright/test';

import { CHROME_PATH, WEB_URL } from '../../web/fixtures/env';

// A bracemark-web profile that has the app installed and its service worker
// running, and that can be closed and opened again as the SAME profile — which
// is what a cold launch is. `web/fixtures/launch.ts` deletes its profile on the
// way in and out on purpose; here the profile surviving the close is the point.

export function pwaRoot(): string {
  const root = process.env.E2E_PWA_ROOT;
  if (!root) {
    throw new Error(
      'E2E_PWA_ROOT is not set — run the PWA cases through `npx nx e2e-pwa @stxapps/e2e`',
    );
  }
  return root;
}

export async function freshProfile(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
}

export async function openProfile(
  dir: string,
  options: { offline?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME_PATH,
    baseURL: WEB_URL,
    headless: true,
    deviceScaleFactor: 2,
    viewport: { width: 1280, height: 900 },
    offline: options.offline,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

// Chrome's own install, then the real service worker.
//
// `PWA.install` is the browser's install path, not a stub: it fetches the
// manifest, applies Chrome's installability checks, and records the app in the
// profile — a wrong manifest id or an uninstallable manifest is refused
// outright. What automation cannot give us is the app WINDOW: a
// `PWA.launch`-ed app still reports `display-mode: browser` under Playwright
// (measured, Chrome 153), and Chrome ignores `display-mode` in media emulation.
// So the app's own trigger — `inner-layout.tsx` registers only when standalone
// or when a registration already exists — never fires here. The case makes
// that first registration with the same script URL `window.serwist.register()`
// uses, after which every load takes the app's existing-registration branch.
// The real standalone window is PWA-RELEASE-001's (web/RELEASE.md).
export async function installAndRegister(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  // No `id` in manifest.json, so the id is its resolved `start_url` ('.').
  const manifestId = new URL('/', WEB_URL).href;
  await cdp.send(
    'PWA.install' as never,
    { manifestId, installUrlOrBundleUrl: page.url() } as never,
  );
  await cdp.detach();

  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    // `ready` resolves on ACTIVATION, which waits for install — the precache.
    await navigator.serviceWorker.ready;
  });
  // clientsClaim: the open page is taken over without a reload.
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}
