import { defineConfig } from '@playwright/test';

import { WEB_URL } from './web/fixtures/env';

// Whole-flow e2e for bracemark-web. The design record — what belongs at this
// layer, why the standard auth fixture cannot work here, and the four repo
// constraints that shape it — is docs/e2e.md. This file is only the wiring.
//
// NOTE the absence of a `projects`/`browserName` block and of anything that would
// launch a browser through the default `browser` fixture. Every spec here goes
// through the `app` fixture in web/fixtures/app.ts, which launches a PERSISTENT
// context because the session is a non-extractable CryptoKey in IndexedDB and
// `storageState` cannot carry it. Adding a plain `page`-fixture spec would appear
// to work and then fail the moment it needed to be signed in.
export default defineConfig({
  testDir: './web',
  // `.e2e.ts`, never `.spec.ts`. Nothing here may be picked up by jest: the
  // `@nx/jest` plugin infers a `test` target from a jest config's mere presence,
  // and `npm run test` means "unit and component, fast, cached" (docs/testing.md).
  // The extension is the second line of that defence, after simply never adding a
  // jest config to this project.
  testMatch: '**/*.e2e.ts',

  // Waits for bracemark-api, which `webServer` below cannot express.
  globalSetup: './global-setup.ts',

  // Every worker holds its own account and its own browser profile, so tests are
  // free to interleave across workers. Two is the useful ceiling on a laptop:
  // each worker pays one Argon2id derivation (64 MiB, t=3) at setup, and the dev
  // stack is three Node processes already.
  fullyParallel: true,
  workers: 2,

  // There is no CI (docs/testing.md), so this is a developer-machine budget, not
  // a pipeline one. One retry buys the trace below without hiding a real break —
  // a spec that only passes on retry should be treated as failing.
  retries: 1,

  // Account creation runs Argon2id in the browser and takes seconds, not
  // milliseconds. A 30s default times out on the create-account spec on a cold
  // profile; 90s leaves room without letting a genuine hang run all afternoon.
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: WEB_URL,
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
  // These two paths are relative to THIS FILE. Anything resolving `.artifacts` at
  // runtime must go through ./paths.ts instead — `testInfo.config.rootDir` is
  // `testDir` (`./web`), not this directory, and using it silently writes outside
  // the one line .gitignore anchors. See the comment in paths.ts.
  outputDir: '.artifacts/test-results',
  reporter: [['list'], ['html', { outputFolder: '.artifacts/report', open: 'never' }]],

  // `npm run dev` is the api + web + extractor stack. `reuseExistingServer` is
  // unconditionally true because there is no CI: the normal case is that the
  // stack is already up in another terminal, and booting a second one would
  // collide on all three ports.
  webServer: {
    command: 'npm run dev',
    cwd: '..',
    url: WEB_URL,
    reuseExistingServer: true,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
