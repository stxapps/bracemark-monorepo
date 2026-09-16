import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import { createRunId } from './runner/lib';
import { API_URL, WEB_URL } from './web/fixtures/env';
import { E2E_ROOT, runArtifactDir } from './paths';

const runId = process.env.E2E_RUN_ID ?? createRunId('web-direct');
process.env.E2E_RUN_ID = runId;
const runDir = process.env.E2E_RUN_DIR ?? runArtifactDir(runId);

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

  // Start missing legs independently. Keying one root `npm run dev` command only
  // to WEB_URL reused an orphaned Next listener while the API was absent, then
  // global setup spent 90 seconds waiting for a process nothing had started.
  // Local runs reuse each verified listener independently; CI owns both.
  webServer: [
    {
      command: 'npx nx dev @stxapps/bracemark-api',
      cwd: join(E2E_ROOT, '..'),
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npx nx dev @stxapps/bracemark-web',
      cwd: join(E2E_ROOT, '..'),
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
