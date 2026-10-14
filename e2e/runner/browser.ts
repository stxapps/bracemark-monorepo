import { chromium, firefox } from '@playwright/test';

import { CHROME_PATH } from '../web/fixtures/env';

// Which engine a web run drives — chosen like the tier, once per process, from
// the environment the runner's Nx target sets (`e2e-web:firefox` sets
// E2E_BROWSER=firefox). Every web launch point reads it from here: launchApp
// (web/fixtures/launch.ts) for the signed-in contexts, and playwright.config.ts
// for the default `page` the anonymous staging checks use.
//
// `chrome` is the system Chrome at CHROME_PATH, as it always was. `firefox` is
// Playwright's own Firefox build: Playwright drives Firefox through its patched
// Juggler protocol, so a stock Firefox from /Applications cannot be used, and
// `npx playwright install firefox` is the second sanctioned browser download
// (docs/e2e.md, _the browser this repo drives_).
//
// Firefox runs only the cases whose registry entry lists it (`browsers` in
// cases.json): the ones whose outcome rests on something Gecko does in its own
// way. Every case still runs on Chrome.
export type E2EBrowser = 'chrome' | 'firefox';

export const E2E_BROWSERS: readonly E2EBrowser[] = ['chrome', 'firefox'];

export function resolveBrowser(env: NodeJS.ProcessEnv = process.env): E2EBrowser {
  const browser = env.E2E_BROWSER ?? 'chrome';
  if (!(E2E_BROWSERS as readonly string[]).includes(browser)) {
    throw new Error(`E2E_BROWSER must be ${E2E_BROWSERS.join(' or ')}, got ${browser}`);
  }
  return browser as E2EBrowser;
}

export const E2E_BROWSER = resolveBrowser();
export const IS_FIREFOX = E2E_BROWSER === 'firefox';

// The Playwright browser type and the launch options that pick the binary.
export const BROWSER_TYPE = IS_FIREFOX ? firefox : chromium;
export const BROWSER_LAUNCH: { executablePath?: string } = IS_FIREFOX
  ? {}
  : { executablePath: CHROME_PATH };

export function browserExecutable(): string {
  return BROWSER_LAUNCH.executablePath ?? BROWSER_TYPE.executablePath();
}
