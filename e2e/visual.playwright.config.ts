import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import { createRunId } from './runner/lib';
import { runArtifactDir } from './paths';
import baseConfig from './playwright.config';

const runId = process.env.E2E_RUN_ID ?? createRunId('visual-direct');
process.env.E2E_RUN_ID = runId;
const runDir = process.env.E2E_RUN_DIR ?? runArtifactDir(runId);

// The web visual checkpoints (docs/e2e.md, _visual checkpoints_). Run them
// through runner/visual.ts, which compares what they capture with the accepted
// baseline; run directly they only photograph.
//
// One project per layout, so each surface is opened at the width a person
// opens it at rather than resized under them — the add surface alone is a
// popover wide and a sheet narrow. Every case owns its account, so the two
// projects share nothing and may run side by side.
export default defineConfig({
  testDir: './visual',
  testMatch: '**/*.e2e.ts',
  globalSetup: './global-setup.ts',
  projects: [{ name: 'wide' }, { name: 'narrow' }],
  fullyParallel: true,
  workers: 2,
  // No retry: a second attempt would photograph over the first, and the
  // comparison would review a capture from a run that failed.
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 15_000 },
  use: {
    ...baseConfig.use,
  },
  outputDir: join(runDir, 'test-results'),
  reporter: [['list'], ['html', { outputFolder: join(runDir, 'report'), open: 'never' }]],
  webServer: baseConfig.webServer,
});
