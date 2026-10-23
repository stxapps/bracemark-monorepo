import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import { BROWSER_LAUNCH, E2E_BROWSER, IS_FIREFOX } from './runner/browser';
import { E2E_ENVIRONMENT, IS_STAGING } from './runner/environment';
import { createRunId } from './runner/lib';
import { selectCases } from './runner/registry';
import { type E2EWidth } from './runner/width';
import { WEB_URL } from './web/fixtures/env';
import { runArtifactDir } from './paths';

const runId = process.env.E2E_RUN_ID ?? createRunId('web-direct');
process.env.E2E_RUN_ID = runId;
const runDir = process.env.E2E_RUN_DIR ?? runArtifactDir(runId);

// The wrapper's case selection (runner/web.ts), applied per PROJECT instead of as
// `--grep`. A command-line filter only reaches the projects it selects directly:
// Playwright runs a DEPENDENCY project whole. So under `--grep`, any selection
// that included the capacity case ran every test in `web` to satisfy `capacity`'s
// dependency on it — `--exclude-trait internet` ran the internet cases, and
// `--case SYNC-BLOCKED-001` ran the whole suite first — while the run's manifest
// went on listing only what had been asked for. A project's own `grep` holds
// however the project comes to run. Unset, local Chrome runs are unfiltered; a
// staging or Firefox run still intersects with the registry's admission list.
const requestedSelection = process.env.E2E_GREP ? new RegExp(process.env.E2E_GREP) : undefined;
const selection =
  IS_STAGING || IS_FIREFOX
    ? new RegExp(
        selectCases('web', { environment: E2E_ENVIRONMENT, browser: E2E_BROWSER })
          .filter((entry) => !requestedSelection || requestedSelection.test(`@${entry.id}`))
          .map((entry) => `@${entry.id}(?=\\s|$)`)
          .join('|') || '(?!)',
      )
    : requestedSelection;

// The wrapper's `--width` (runner/web.ts): one window's projects, or, unset,
// both. In the environment rather than as `--project`, which `nx` drops.
const runWidth = process.env.E2E_WIDTH as E2EWidth | undefined;
const runsWide = runWidth !== 'narrow';

// The narrow window (docs/e2e.md, _narrow and wide_): the cases whose entry
// admits `narrow`, run again at 390×844 by the `narrow` project, intersected
// with the wrapper's selection the same per-project way as above. Local Chrome
// only: width matters to layout, and neither the engine (Firefox) nor the server
// path (staging) is split by it — the native legs make the same call.
const runsNarrow = !IS_STAGING && !IS_FIREFOX && runWidth !== 'wide';
const narrowSelection = new RegExp(
  selectCases('web', { width: 'narrow' })
    .filter((entry) => !requestedSelection || requestedSelection.test(`@${entry.id}`))
    .map((entry) => `@${entry.id}(?=\\s|$)`)
    .join('|') || '(?!)',
);

// Whole-flow e2e for bracemark-web. The design record — what belongs at this
// layer, why the standard auth fixture cannot work here, and the four repo
// constraints that shape it — is docs/e2e.md. This file is only the wiring.
//
// Signed-in specs use the `app` fixture in web/fixtures/app.ts, which launches a PERSISTENT
// context because the session is a non-extractable CryptoKey in IndexedDB and
// `storageState` cannot carry it. Adding a plain `page`-fixture spec would appear
// to work and then fail the moment it needed to be signed in. Anonymous staging
// security checks use the default browser fixture and need no session.
export default defineConfig<object, { layout: E2EWidth }>({
  testDir: IS_STAGING ? '.' : './web',
  // `.e2e.ts`, never `.spec.ts`. Nothing here may be picked up by jest: the
  // `@nx/jest` plugin infers a `test` target from a jest config's mere presence,
  // and `npm run test` means "unit and component, fast, cached" (docs/testing.md).
  // The extension is the second line of that defence, after simply never adding a
  // jest config to this project.
  testMatch: IS_STAGING ? ['web/**/*.e2e.ts', 'staging/**/*.e2e.ts'] : '**/*.e2e.ts',

  // The capacity case runs LAST and ALONE: it fills an account to the storage
  // ceiling through the one local api and R2 and then wipes it, and a spec
  // sharing the stack meanwhile timed out on its own sync and delete-all
  // receipts. A dependent project starts only after `web` has finished — and is
  // skipped if `web` failed, which a red run reports as "did not run".
  //
  // `narrow` is the same specs at the narrow window, for the cases admitted
  // there; capacity waits for it too, or it would no longer run alone. A
  // `--width` run keeps one window's projects, and capacity is a wide one.
  projects: [
    ...(runsWide
      ? [
          {
            name: 'web',
            testIgnore: '**/capacity.e2e.ts',
            grep: selection,
            use: { layout: 'wide' as const },
          },
        ]
      : []),
    ...(runsNarrow
      ? [
          {
            name: 'narrow',
            testIgnore: '**/capacity.e2e.ts',
            grep: narrowSelection,
            use: { layout: 'narrow' as const },
          },
        ]
      : []),
    ...(runsWide
      ? [
          {
            name: 'capacity',
            testMatch: '**/capacity.e2e.ts',
            dependencies: runsNarrow ? ['web', 'narrow'] : ['web'],
            grep: selection,
            use: { layout: 'wide' as const },
          },
        ]
      : []),
  ],

  // No `webServer`: `npm run dev` is the one definition of the stack, and this
  // proves it is up and this checkout's (docs/e2e.md, _running it_).
  globalSetup: './global-setup.ts',

  // Every worker holds its own account and its own browser profile, so tests are
  // free to interleave across workers. Two is the useful ceiling on a laptop:
  // each worker pays one Argon2id derivation (64 MiB, t=3) at setup, and the dev
  // stack is three Node processes already.
  fullyParallel: true,
  workers: IS_STAGING ? 1 : 2,

  // There is no CI (docs/testing.md), so this is a developer-machine budget, not
  // a pipeline one. One retry buys the trace below without hiding a real break —
  // a spec that only passes on retry should be treated as failing.
  retries: 1,
  // Retrying is useful evidence, but a pass on retry is still a broken quality
  // gate. The retained trace shows both attempts while the command exits red.
  failOnFlakyTests: true,

  // Account creation runs Argon2id in the browser and takes seconds, not
  // milliseconds. A 30s default times out on the create-account spec on a cold
  // profile; 90s leaves room without letting a genuine hang run all afternoon.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: WEB_URL,
    bypassCSP: false,
    ignoreHTTPSErrors: false,
    // The default `page` the anonymous staging checks use; signed-in contexts
    // pick their binary the same way, in launchApp.
    browserName: IS_FIREFOX ? 'firefox' : 'chromium',
    launchOptions: BROWSER_LAUNCH,
    // Without this a click on a control that never appears waits out the whole
    // 90s TEST budget and then reports "Target page, context or browser has been
    // closed" — naming no step. Actions resolve against an already-rendered page;
    // the genuinely slow waits (Argon2id, a sync) are `expect`s with their own
    // explicit timeouts, which this does not touch.
    actionTimeout: 15_000,
    // Retained only on failure: a trace per passing test fills .artifacts fast,
    // and the failing one is the only one anybody opens.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  // Everything this run writes lands under one gitignored directory, alongside
  // the browser profiles the app fixture creates. `npm run e2e-web:report` opens
  // the HTML report; `open: 'never'` keeps a failed run from hijacking a browser
  // tab mid-task, which matters when an agent is driving.
  //
  // The wrapper supplies one absolute run directory. Anything resolving
  // `.artifacts` at runtime must still go through ./paths.ts —
  // `testInfo.config.rootDir` is `testDir` (`./web`), not this directory.
  outputDir: join(runDir, 'test-results'),
  reporter: [['list'], ['html', { outputFolder: join(runDir, 'report'), open: 'never' }]],
});
