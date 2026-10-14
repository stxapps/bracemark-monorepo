import { rm } from 'node:fs/promises';

import { type BrowserContext, expect, type Page, test as base } from '@playwright/test';

import { profileDir } from '../../paths';
import { takeCspViolations } from '../../web/fixtures/csp';
import { launchApp, type LaunchedApp } from '../../web/fixtures/launch';
import {
  extensionId,
  launchExtensionProfile,
  openExtensionPopup,
  signInExtension,
} from './extension';

export interface ExtensionApp {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly subject: Page;
  readonly profile: string;
  open(url: string): Promise<Page>;
  signIn(url: string): Promise<Page>;
  restart(): Promise<void>;
}

interface ExtensionFixtures {
  webApp: LaunchedApp;
  extensionApp: ExtensionApp;
  cspGuard: void;
}

function safeTestId(testId: string): string {
  return testId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(-80);
}

export const test = base.extend<ExtensionFixtures>({
  // The web half of every case is a signed-in bracemark-web client, and on
  // staging it runs under the deployed CSP: fail a case whose web profiles —
  // the fixture's and any reader a case opens — reported a violation, as the web
  // fixture does (web/fixtures/app.ts, `cspGuard`). Local runs send no CSP and
  // never trip it. The browser-extension pages are not watched: their policy is
  // the manifest's, not the CDN's.
  cspGuard: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use();
      expect(takeCspViolations(), 'the journey violated the deployed CSP').toEqual([]);
    },
    { auto: true },
  ],

  // Every extension case owns a disposable account. Several cases are ordering,
  // destructive, or multi-profile by construction, so worker sharing would make
  // their local stores and server ops part of one another's setup.
  // eslint-disable-next-line no-empty-pattern
  webApp: async ({}, use, testInfo) => {
    const label = safeTestId(testInfo.testId);
    const app = await launchApp(profileDir(`extension-web-w${testInfo.workerIndex}-${label}`));
    await use(app);
    await app.close();
  },

  extensionApp: async ({ webApp }, use, testInfo) => {
    const extractionCase = testInfo.tags.includes('@EXT-EXTRACT-001');
    const extension = extractionCase
      ? process.env.E2E_EXTENSION_EXTRACTION_PATH
      : process.env.E2E_EXTENSION_PATH;
    if (!extension) {
      throw new Error(
        'run browser-extension specs through `npx nx e2e-extension @stxapps/e2e` ' +
          '(or `e2e-extension:staging`)',
      );
    }
    const extensionPath = extension;

    const label = safeTestId(testInfo.testId);
    const profile = profileDir(`extension-chromium-w${testInfo.workerIndex}-${label}`);
    let context!: BrowserContext;
    let id = '';
    let subject!: Page;

    async function launch(resetProfile: boolean): Promise<void> {
      context = await launchExtensionProfile(profile, extensionPath, { resetProfile });
      id = await extensionId(context);
      subject = await context.newPage();
      await Promise.all(
        context
          .pages()
          .filter((page) => page !== subject)
          .map((page) => page.close()),
      );
    }

    await launch(true);

    const app: ExtensionApp = {
      get context() {
        return context;
      },
      get extensionId() {
        return id;
      },
      get subject() {
        return subject;
      },
      profile,
      async open(url) {
        await subject.goto(url, { waitUntil: 'domcontentloaded' });
        return openExtensionPopup(context, id, subject);
      },
      async signIn(url) {
        const popup = await app.open(url);
        await signInExtension(popup, webApp.credentials);
        return popup;
      },
      async restart() {
        await context.close();
        await launch(false);
      },
    };

    try {
      await use(app);
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  },
});

export { expect };
