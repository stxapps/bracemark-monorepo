import { type Page, test as base } from '@playwright/test';

import { profileDir } from '../../paths';
import { type Credentials } from './account';
import { launchApp, type LaunchedApp } from './launch';

// THE fixture for every web e2e. Read the constraint before changing it.
//
// bracemark-web's session lives in IndexedDB (`bracemark-session`) and holds a
// NON-EXTRACTABLE CryptoKey — deliberately, so an XSS can use the key but never
// exfiltrate it (packages/web-react/src/data/session-store.ts). Playwright's
// `storageState` serialises to JSON. A non-extractable CryptoKey is
// structured-cloneable but not JSON-serialisable, so the standard "sign in once,
// replay storageState into every test" fixture CANNOT work here, in any Playwright
// version — and it fails by handing you a signed-out page, not by erroring.
//
// What does work is a real on-disk profile: `launchPersistentContext` keeps
// IndexedDB, and the key comes back still non-extractable. So the unit of reuse is
// a browser PROFILE, not a serialised state blob — which is why the context is
// worker-scoped and the account is created through the UI exactly once per worker.
//
// The consequence for spec authors: every test in a worker shares one account and
// one accumulating data set. Namespace anything you create with `unique()` (in
// ./data), never assert on a global count ("3 links exist"), and never sign out —
// take an isolated app via `launchApp` for that (see account.e2e.ts).
interface AppFixtures {
  page: Page;
  credentials: Credentials;
}

interface AppWorkerFixtures {
  app: LaunchedApp;
}

export const test = base.extend<AppFixtures, AppWorkerFixtures>({
  app: [
    // The empty pattern is REQUIRED, not a style choice: Playwright reads this
    // signature to work out which fixtures the function depends on, and rejects
    // anything that isn't a destructuring pattern ("First argument must use the
    // object destructuring pattern"). `_` fails at runtime. Hence the disable.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, workerInfo) => {
      const app = await launchApp(profileDir(`w${workerInfo.workerIndex}`));
      await use(app);
      await app.close();
    },
    { scope: 'worker' },
  ],

  credentials: async ({ app }, use) => {
    await use(app.credentials);
  },

  // One page per test on the shared context, so a test that navigates away or
  // leaves a dialog open can't strand the next one.
  //
  // Note what is NOT here: any tracing calls. `use.trace` / `use.screenshot` in
  // playwright.config.ts apply to a persistent context too — the runner
  // instruments every context created through its API, not just the ones its own
  // `context` fixture builds. Starting tracing by hand here fails outright with
  // "Tracing has been already started".
  page: async ({ app }, use) => {
    const page = await app.context.newPage();
    await use(page);
    await page.close();
  },
});

export { expect } from '@playwright/test';
