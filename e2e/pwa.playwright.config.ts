import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import { createRunId } from './runner/lib';
import { runArtifactDir } from './paths';

const runId = process.env.E2E_RUN_ID ?? createRunId('pwa-direct');
process.env.E2E_RUN_ID = runId;
const runDir = process.env.E2E_RUN_DIR ?? runArtifactDir(runId);

// The installed-PWA cases (docs/e2e.md, _the PWA target_). Run them through
// runner/pwa.ts: it builds the production export against the local stack and
// hands its staged copy over as E2E_PWA_ROOT. There is no `webServer` for the
// web origin on purpose — the spec serves the export itself so it can stop it.
export default defineConfig({
  testDir: './pwa',
  testMatch: '**/*.e2e.ts',
  globalSetup: './pwa/global-setup.ts',
  // One origin on one port, which each case starts and stops.
  fullyParallel: false,
  workers: 1,
  retries: 1,
  failOnFlakyTests: true,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  use: {
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  outputDir: join(runDir, 'test-results'),
  reporter: [['list'], ['html', { outputFolder: join(runDir, 'report'), open: 'never' }]],
});
