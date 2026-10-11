import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import { createRunId } from './runner/lib';
import { API_URL, WEB_URL } from './web/fixtures/env';
import { E2E_ROOT, runArtifactDir } from './paths';

const runId = process.env.E2E_RUN_ID ?? createRunId('extension-direct');
process.env.E2E_RUN_ID = runId;
const runDir = process.env.E2E_RUN_DIR ?? runArtifactDir(runId);

// SIGTERM, not Playwright's default SIGKILL, so nx stops the dev server it
// spawned instead of orphaning it (playwright.config.ts, `STACK_SHUTDOWN`).
const STACK_SHUTDOWN = { signal: 'SIGTERM', timeout: 10_000 } as const;

export default defineConfig({
  testDir: './extension',
  testMatch: '**/*.e2e.ts',
  globalSetup: './global-setup.ts',
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
  webServer: [
    {
      command: 'npx nx dev @stxapps/bracemark-api',
      cwd: join(E2E_ROOT, '..'),
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      gracefulShutdown: STACK_SHUTDOWN,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npx nx dev @stxapps/bracemark-web',
      cwd: join(E2E_ROOT, '..'),
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      gracefulShutdown: STACK_SHUTDOWN,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
