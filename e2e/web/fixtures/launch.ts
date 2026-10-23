import { rm } from 'node:fs/promises';

import { type BrowserContext, type Page } from '@playwright/test';

import { BROWSER_LAUNCH, BROWSER_TYPE } from '../../runner/browser';
import {
  createAccount,
  createAccountWithRecovery,
  type Credentials,
  newCredentials,
  signIn,
} from './account';
import { watchCspViolations } from './csp';
import { WEB_URL } from './env';
import { WEB_VIEWPORTS } from './layout';

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
  // Only the seeds want this (seed/accounts.ts, shot/account.ts): their
  // accounts are named so a human can sign back into them tomorrow, which is the
  // opposite of what a spec wants and the reason `newCredentials()` stays the
  // default. It still goes through the same create-account ceremony — there is no
  // seeding shortcut here either (see ./account.ts) — so the only thing it
  // changes is who gets created.
  create?: Credentials;
  // Take create-account's recovery-code exit instead of skipping it, and return
  // the minted code as `recoveryCode`. Only the mobile runner wants this — see
  // createAccountWithRecovery. Ignored when `existing` is set: that account was
  // created elsewhere and its code, if any, was shown once and is gone.
  withRecovery?: boolean;
  // Skip the account ceremony altogether and hand back the first page, signed
  // out, with `credentials` minted and unused. Only shot/ wants this: its picture
  // of create-account's recovery step is of a screen the ceremony walks THROUGH,
  // and an account nobody finishes creating is one nobody has to clean up.
  // Ignored when `existing` or `create` is set.
  signedOut?: boolean;
  // Watch the run. `slowMo` is only useful with this on. Unset, they follow
  // E2E_HEADED and E2E_SLOW_MO, which runner/web.ts sets from `--headed` and
  // `--slow-mo`: Playwright's own flag reaches only a browser Playwright
  // launches, and every context here is launched by this function — a headed
  // run stayed headless until this read it.
  headed?: boolean;
  slowMo?: number;
  // Raster density for `page.screenshot`. 2 everywhere except the marketing
  // capture (shot/), which asks for 3 — and the reason is a constraint one
  // step downstream: `make-image-variants.sh` refuses to upscale, so the widest
  // variant the site ships (2200px) needs a source at least that wide. The
  // capture's CSS width is a DESIGN choice — it sets how large the app's own type
  // renders inside the figure, and how much air sits between a title and the date
  // column — so it must not be forced up to 1100 just to reach 2200 device px.
  // Splitting the two lets the shot pick 1000 CSS and still hand the script 3000.
  deviceScaleFactor?: number;
  // The web origin, when it is not WEB_URL's. Only the data-path measurement
  // (measure/data-web.ts) passes one: it serves a production export it built itself,
  // and WEB_URL is fixed when env.ts loads, before a script could point it there.
  baseURL?: string;
  // Runs on the fresh context BEFORE the account ceremony. For a case that has to
  // see, or hold, the very first requests a sign-in makes: a device's first sync
  // starts the moment its sign-in lands, inside this function, so a route added
  // after `launchApp` returns is already too late for it (SYNC-LISTING-001).
  prepare?: (context: BrowserContext) => Promise<void>;
  // Keep the app's service worker from registering. Only the sync measurement
  // (measure/sync.ts) asks: a production build's worker carries every
  // cross-origin request, R2's included, and blocking it is how that run
  // prices the worker and sees the requests it otherwise hides.
  serviceWorkers?: 'allow' | 'block';
  // The window the profile opens at. Omitted is the desktop window every spec
  // was first written at; the `narrow` project passes its own (./layout.ts).
  viewport?: { width: number; height: number };
}

export async function launchApp(
  userDataDir: string,
  options: LaunchOptions = {},
): Promise<LaunchedApp> {
  // A profile left by an earlier run holds a session for an account that run
  // abandoned — signed in, but to nothing the current run has the password for.
  await rm(userDataDir, { recursive: true, force: true });

  // System Chrome, or Playwright's Firefox on a Firefox run (runner/browser.ts).
  // A Firefox profile keeps IndexedDB, and the non-extractable key in it, the
  // same way, so nothing else here changes.
  const context = await BROWSER_TYPE.launchPersistentContext(userDataDir, {
    ...BROWSER_LAUNCH,
    baseURL: options.baseURL ?? WEB_URL,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
    headless: !(options.headed ?? process.env.E2E_HEADED === '1'),
    slowMo: options.slowMo ?? (Number(process.env.E2E_SLOW_MO) || undefined),
    // The repo's type sizes are small enough that a 1x screenshot is hard to read
    // when a failure needs eyeballing.
    deviceScaleFactor: options.deviceScaleFactor ?? 2,
    viewport: options.viewport ?? WEB_VIEWPORTS.wide,
    ...(options.serviceWorkers ? { serviceWorkers: options.serviceWorkers } : {}),
  });

  // Before the account ceremony: Argon2's wasm and its blob-started worker are
  // the first things a policy can refuse.
  await watchCspViolations(context, options.baseURL);

  await options.prepare?.(context);

  const credentials = options.existing ?? options.create ?? newCredentials();
  const page = context.pages()[0] ?? (await context.newPage());

  let recoveryCode: string | undefined;
  if (options.existing) await signIn(page, credentials);
  else if (options.signedOut && !options.create) await page.goto('/');
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
