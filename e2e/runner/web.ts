import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { E2E_ROOT, runArtifactDir } from '../paths';
import { proveStagingPlanAccess } from '../seed/d1';
import { API_URL, CHROME_PATH, WEB_URL } from '../web/fixtures/env';
import { parseWebCli } from './cli';
import { E2E_ENVIRONMENT, E2E_ORIGINS, IS_STAGING } from './environment';
import { createRunId, writeJson } from './lib';
import { capture, inherit } from './process';
import { readCaseRegistry, selectCases, validateCaseRegistry } from './registry';
import { assertStackOwnedByRepo } from './stack';
import { STAGING_PLAN_GRANTS } from './staging-credential';

async function main(): Promise<void> {
  validateCaseRegistry();
  const options = parseWebCli();
  if (
    options.playwrightArgs.some(
      (argument) => argument === '--grep' || argument.startsWith('--grep='),
    )
  ) {
    throw new Error(
      'use --case/--suite/--include-trait/--exclude-trait; do not combine them with --grep',
    );
  }
  const selected = selectCases('web', { ...options, environment: E2E_ENVIRONMENT });

  // If a stack already exists, prove it belongs to this checkout before
  // Playwright's reuseExistingServer path can silently attach to it. Missing
  // listeners are fine here: Playwright will start the stack itself.
  await assertStackOwnedByRepo([
    { origin: WEB_URL, label: 'bracemark-web' },
    { origin: API_URL, label: 'bracemark-api' },
  ]);

  // The one credential a staging run can need, proved before a run directory
  // exists or Playwright creates an account: a selected case that grants a plan
  // writes a row to staging's remote D1 (seed/d1.ts). Listing writes nothing, so
  // it asks for nothing — and a run with no such case never touches the keychain.
  const stagingGrants = selected.filter((testCase) => testCase.stagingGrants?.includes('plan'));
  const stagingPlanFrom =
    IS_STAGING && stagingGrants.length > 0 && !options.playwrightArgs.includes('--list')
      ? await proveStagingPlanAccess()
      : undefined;

  const runId = createRunId(IS_STAGING ? 'staging-web' : 'web');
  const runDir = runArtifactDir(runId);
  await mkdir(runDir, { recursive: true });
  // The selection travels in the environment, not as `--grep`: the config applies
  // it to each project, which is the only filter a dependency project honours
  // (playwright.config.ts, `selection`).
  const grep = selected.map((testCase) => `@${testCase.id}(?=\\s|$)`).join('|');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_RUN_ID: runId,
    E2E_RUN_DIR: runDir,
    E2E_GREP: grep,
  };
  const args = ['test', ...options.playwrightArgs];

  if (stagingPlanFrom) {
    console.log(
      `staging plan grants: ${stagingGrants.map((testCase) => testCase.id).join(', ')} — ` +
        `token from ${stagingPlanFrom}`,
    );
    env[STAGING_PLAN_GRANTS] = '1';
  }
  const [playwrightVersion, chromeVersion, commit, status] = await Promise.all([
    capture('playwright', ['--version'], { cwd: E2E_ROOT, env }),
    capture(CHROME_PATH, ['--version'], { allowFailure: true }),
    capture('git', ['rev-parse', 'HEAD'], { cwd: join(E2E_ROOT, '..') }),
    capture('git', ['status', '--porcelain'], { cwd: join(E2E_ROOT, '..') }),
  ]);
  const manifestPath = join(runDir, 'run.json');
  const manifest = {
    schemaVersion: 1,
    runId,
    kind: 'web',
    environment: E2E_ENVIRONMENT,
    status: 'running',
    startedAt: new Date().toISOString(),
    suite: options.suite,
    filters: {
      cases: options.cases,
      includeTraits: options.includeTraits,
      excludeTraits: options.excludeTraits,
    },
    selectedCases: selected.map((testCase) => testCase.id),
    stagingGrants: IS_STAGING ? stagingGrants.map((testCase) => testCase.id) : [],
    origins: E2E_ORIGINS,
    excludedCases: IS_STAGING
      ? readCaseRegistry()
          .filter(
            (entry) =>
              entry.surface === 'web' && !(entry.environments ?? ['local']).includes('staging'),
          )
          .map((entry) => entry.id)
      : [],
    browser: { executable: CHROME_PATH, version: chromeVersion.stdout.trim() || 'unknown' },
    playwrightVersion: playwrightVersion.stdout.trim(),
    checkout: {
      root: join(E2E_ROOT, '..'),
      commit: commit.stdout.trim(),
      dirty: status.stdout.trim().length > 0,
    },
    command: { command: 'playwright', args },
    finishedAt: undefined as string | undefined,
  };
  await writeJson(manifestPath, manifest);
  await writeJson(join(E2E_ROOT, '.artifacts', 'latest-web-run.json'), { runId, runDir });

  try {
    await inherit('playwright', args, { cwd: E2E_ROOT, env });
    manifest.status = options.playwrightArgs.includes('--list') ? 'listed' : 'passed';
  } catch (error) {
    manifest.status = 'failed';
    throw error;
  } finally {
    manifest.finishedAt = new Date().toISOString();
    await writeJson(manifestPath, manifest);
    console.log(`web E2E artifacts: ${runDir}`);
  }
}

await main();
