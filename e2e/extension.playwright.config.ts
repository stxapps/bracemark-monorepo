import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import { IS_STAGING } from './runner/environment';
import { createRunId } from './runner/lib';
import { selectCases } from './runner/registry';
import { runArtifactDir } from './paths';

const runId = process.env.E2E_RUN_ID ?? createRunId('extension-direct');
process.env.E2E_RUN_ID = runId;
const runDir = process.env.E2E_RUN_DIR ?? runArtifactDir(runId);

// The runner selects with `--grep`; a staging run is also held to the registry's
// admission list here, so a direct `playwright test` cannot carry a local-only
// case to the deployed tier (playwright.config.ts does the same for web).
const stagingAdmitted = IS_STAGING
  ? new RegExp(
      selectCases('extension', { environment: 'staging' })
        .map((entry) => `@${entry.id}(?=\\s|$)`)
        .join('|') || '(?!)',
    )
  : undefined;

export default defineConfig({
  testDir: './extension',
  testMatch: '**/*.e2e.ts',
  globalSetup: './extension/global-setup.ts',
  grep: stagingAdmitted,
  fullyParallel: true,
  // Every case already runs system Chrome for account setup plus headed bundled
  // Chromium for the unpacked extension. Two workers means four concurrent
  // browser processes; measured here, both auth ceremonies stalled until the
  // test timeout. Serial is faster than retrying that contention and deterministic.
  workers: 1,
  retries: 1,
  failOnFlakyTests: true,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  outputDir: join(runDir, 'test-results'),
  reporter: [['list'], ['html', { outputFolder: join(runDir, 'report'), open: 'never' }]],
});
