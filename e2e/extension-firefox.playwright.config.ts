import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import { createRunId } from './runner/lib';
import { runArtifactDir } from './paths';

const runId = process.env.E2E_RUN_ID ?? createRunId('extension-firefox-direct');
process.env.E2E_RUN_ID = runId;
const runDir = process.env.E2E_RUN_DIR ?? runArtifactDir(runId);

// The browser extension's Firefox cases (runner/extension-firefox.ts). No
// globalSetup: they need no stack — each serves its own pages and drives its own
// Firefox (extension/firefox/fixture.ts) — so a run works with `npm run dev` down.
export default defineConfig({
  testDir: './extension/firefox',
  testMatch: '**/*.e2e.ts',
  workers: 1,
  retries: 1,
  failOnFlakyTests: true,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  outputDir: join(runDir, 'test-results'),
  reporter: [['list'], ['html', { outputFolder: join(runDir, 'report'), open: 'never' }]],
});
