import { rm } from 'node:fs/promises';

import { type BrowserContext, chromium, type Page } from '@playwright/test';

import {
  createAccount,
  createAccountWithRecovery,
  type Credentials,
  newCredentials,
  signIn,
} from './account';
import { CHROME_PATH, WEB_URL } from './env';

// Launching a signed-in bracemark-web, as a plain function rather than a fixture —
// because three callers need it and only one of them is a spec: the worker fixture
// in app.ts, the sign-out spec (which must NOT share the worker's session, since
// signing out would strand every later test in that worker), and the contract
// runner in ../../contract/, which has no Playwright test context at all.
//
// The persistent profile is the whole point. See app.ts for why `storageState`
// cannot be used here.

export interface LaunchedApp {
  context: BrowserContext;
  // The page the account was created (or signed in) on. Returned rather than left
  // to callers to dig out of `context.pages()[0]`, which is only reliably the
  // right one because we put it there.
  page: Page;
  credentials: Credentials;
  // Present only when `withRecovery` was asked for. Undefined otherwise because
  // the account genuinely has no recovery door, not because it wasn't captured.
  recoveryCode?: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  // Sign in to an existing account instead of creating a new one. The contract
  // runner's reverse leg uses this: the account was made on the phone.
  existing?: Credentials;
  // Create an account with THESE credentials instead of freshly minted ones.
  // Only the seed wants this (seed/seed.ts): its accounts are named so a human
  // can sign back into them tomorrow, which is the opposite of what a spec wants
  // and the reason `newCredentials()` stays the default. It still goes through
  // the same create-account ceremony — there is no seeding shortcut here either
  // (see ./account.ts) — so the only thing it changes is who gets created.
  create?: Credentials;
  // Take create-account's recovery-code exit instead of skipping it, and return
  // the minted code as `recoveryCode`. Only the mobile runner wants this — see
  // createAccountWithRecovery. Ignored when `existing` is set: that account was
  // created elsewhere and its code, if any, was shown once and is gone.
  withRecovery?: boolean;
  // Watch the run. `slowMo` is only useful with this on.
  headed?: boolean;
  slowMo?: number;
}

export async function launchApp(
  userDataDir: string,
  options: LaunchOptions = {},
): Promise<LaunchedApp> {
  // A profile left by an earlier run holds a session for an account that run
  // abandoned — signed in, but to nothing the current run has the password for.
  await rm(userDataDir, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: CHROME_PATH,
    baseURL: WEB_URL,
    headless: !options.headed,
    slowMo: options.slowMo,
    // The repo's type sizes are small enough that a 1x screenshot is hard to read
    // when a failure needs eyeballing.
    deviceScaleFactor: 2,
    viewport: { width: 1280, height: 900 },
  });

  const credentials = options.existing ?? options.create ?? newCredentials();
  const page = context.pages()[0] ?? (await context.newPage());

  let recoveryCode: string | undefined;
  if (options.existing) await signIn(page, credentials);
  else if (options.withRecovery) recoveryCode = await createAccountWithRecovery(page, credentials);
  else await createAccount(page, credentials);

  return {
    context,
    page,
    credentials,
    recoveryCode,
    async close() {
      await context.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}
