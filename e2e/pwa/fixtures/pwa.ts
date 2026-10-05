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
  // ⚠ `offline` alone does NOT take the network away from the SERVICE WORKER:
  // Chromium's offline emulation covers the page, not fetches the worker makes
  // itself — and the worker's cross-origin rule re-fetches every api request in
  // the worker (sw.ts). Measured: an "offline" page whose worker forwarded
  // `GET /v1/auth/session` got the local api's 401. So "the api is gone" was
  // never true in these cases until every request leaving the app's origin was
  // also aborted here, which context routing does apply to worker requests.
  if (options.offline) {
    const appOrigin = new URL(WEB_URL).origin;
    await context.route(
      (url) => url.origin !== appOrigin,
      (route) => route.abort('internetdisconnected'),
    );
  }
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

// Undo `openProfile({ offline: true })`: the page's network and the worker's.
export async function restoreNetwork(context: BrowserContext): Promise<void> {
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await context.setOffline(false);
}

// Chrome's own install, then the real service worker.
//
// `PWA.install` is the browser's install path, not a stub: it fetches the
// manifest, applies Chrome's installability checks, and records the app in the
// profile — a wrong manifest id or an uninstallable manifest is refused
// outright. What automation cannot give us is the app WINDOW: a
// `PWA.launch`-ed app still reports `display-mode: browser` (measured, Chrome 153),
// and Chrome ignores `display-mode` in media emulation. The app no longer needs
// the window to register — `inner-layout.tsx` registers after sign-in in any
// display mode (PWA-004 proves that path on its own) — so the explicit
// registration here only makes the installed cases wait for ACTIVATION
// deterministically before they go offline.
//
// ⚠ It has to be the SAME registration the app makes, and that is three values,
// not one: the script URL, the scope, and the TYPE. `SerwistProvider` registers
// `/sw.js` as a `module` worker; a bare `register('/sw.js')` asks for a classic
// one, and to the browser a different type is a different worker — it installs
// the script a SECOND time and replaces the app's worker a moment after it
// activated. Two things followed, and nothing failed on either:
//   - every installed case ran a classic worker, which production never does;
//   - a page load issued in that moment was handed to the first worker just as
//     it was discarded, and never completed (measured: the worker reported no
//     fetch event for it, 40 s later). The cases only escaped because each saves
//     a link and syncs before its first page load.
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
    await navigator.serviceWorker.register('/sw.js', { scope: '/', type: 'module' });
    // `ready` resolves on ACTIVATION, which waits for install — the precache.
    await navigator.serviceWorker.ready;
  });
  // clientsClaim: the open page is taken over without a reload.
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);
}
