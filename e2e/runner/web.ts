import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { E2E_ROOT, runArtifactDir } from '../paths';
import { proveStagingPlanAccess } from '../seed/d1';
import { API_URL, EXTRACTOR_URL, WEB_URL } from '../web/fixtures/env';
import { browserExecutable, E2E_BROWSER, IS_FIREFOX } from './browser';
import { parseWebCli } from './cli';
import { E2E_ENVIRONMENT, E2E_ORIGINS, IS_STAGING } from './environment';
import { createRunId, writeJson } from './lib';
import { capture, inherit } from './process';
import { readCaseRegistry, selectCases, validateCaseRegistry } from './registry';
import { assertStackOwnedByRepo } from './stack';
import { STAGING_PLAN_GRANTS } from './staging-credential';

async function main(): Promise<void> {
  validateCaseRegistry();
  const options = parseWebCli(undefined, true);
  if (
    options.playwrightArgs.some(
      (argument) => argument === '--grep' || argument.startsWith('--grep='),
    )
  ) {
    throw new Error(
      'use --case/--suite/--include-trait/--exclude-trait; do not combine them with --grep',
    );
  }
  // `--width` is the one way to pick a window: Playwright's `--project` is also
  // `nx`'s, which keeps it without a word, so through a root script it never
  // arrives and the run is silently both (docs/e2e.md, _the narrow web project_).
  if (
    options.playwrightArgs.some(
      (argument) => argument === '--project' || argument.startsWith('--project='),
    )
  ) {
    throw new Error('use --width narrow or --width wide; --project is not passed through');
  }
  if (options.width === 'narrow' && (IS_STAGING || IS_FIREFOX)) {
    throw new Error(
      'the narrow window runs on local Chrome only (docs/e2e.md, _the narrow web project_)',
    );
  }
  const selected = selectCases('web', {
    ...options,
    environment: E2E_ENVIRONMENT,
    browser: E2E_BROWSER,
  });
  // Playwright's own Firefox, not the one in /Applications (runner/browser.ts).
  // Checked before anything waits on the stack, as the browser extension's
  // Chromium is in runner/extension.ts.
  const executable = browserExecutable();
  if (IS_FIREFOX && !existsSync(executable)) {
    throw new Error(
      'Playwright Firefox is not installed. Run `npx playwright install firefox` and retry.',
    );
  }

  // The stack is `npm run dev`'s, and must be up and this checkout's before a
  // run directory exists (global-setup.ts then waits for it to answer). Listing
  // talks to nothing; staging origins are not local and pass through.
  const required = !options.playwrightArgs.includes('--list');
  await assertStackOwnedByRepo([
    { origin: WEB_URL, label: 'bracemark-web', required },
    { origin: API_URL, label: 'bracemark-api', required },
    { origin: EXTRACTOR_URL, label: 'bracemark-extractor', required },
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

  const runId = createRunId(`${IS_STAGING ? 'staging-' : ''}web${IS_FIREFOX ? '-firefox' : ''}`);
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
  // The width travels the same way, to drop the other window's project.
  if (options.width) env.E2E_WIDTH = options.width;
  const args = ['test', ...options.playwrightArgs];
  // `--headed` alone changes nothing: the specs launch their own persistent
  // contexts (web/fixtures/launch.ts), which read these instead.
  if (options.playwrightArgs.includes('--headed')) env.E2E_HEADED = '1';
  if (options.slowMo) env.E2E_SLOW_MO = String(options.slowMo);

  if (stagingPlanFrom) {
    console.log(
      `staging plan grants: ${stagingGrants.map((testCase) => testCase.id).join(', ')} — ` +
        `token from ${stagingPlanFrom}`,
    );
    env[STAGING_PLAN_GRANTS] = '1';
  }
  const [playwrightVersion, browserVersion, commit, status] = await Promise.all([
    capture('playwright', ['--version'], { cwd: E2E_ROOT, env }),
    capture(executable, ['--version'], { allowFailure: true }),
    capture('git', ['rev-parse', 'HEAD'], { cwd: join(E2E_ROOT, '..') }),
    capture('git', ['status', '--porcelain'], { cwd: join(E2E_ROOT, '..') }),
  ]);
  const manifestPath = join(runDir, 'run.json');
  const manifest = {
    schemaVersion: 1,
    runId,
    kind: 'web',
    environment: E2E_ENVIRONMENT,
    browserName: E2E_BROWSER,
    status: 'running',
    startedAt: new Date().toISOString(),
    suite: options.suite,
    // Absent: both windows, as the config has them.
    width: options.width,
    filters: {
      cases: options.cases,
      includeTraits: options.includeTraits,
      excludeTraits: options.excludeTraits,
    },
    selectedCases: selected.map((testCase) => testCase.id),
    stagingGrants: IS_STAGING ? stagingGrants.map((testCase) => testCase.id) : [],
    origins: E2E_ORIGINS,
    // What this tier and engine leave out — staging's local-only cases, and on
    // Firefox every case its registry entry does not list.
    excludedCases:
      IS_STAGING || IS_FIREFOX
        ? readCaseRegistry()
            .filter(
              (entry) =>
                entry.surface === 'web' &&
                (!(entry.environments ?? ['local']).includes(E2E_ENVIRONMENT) ||
                  !(entry.browsers ?? ['chrome']).includes(E2E_BROWSER)),
            )
            .map((entry) => entry.id)
        : [],
    browser: { executable, version: browserVersion.stdout.trim() || 'unknown' },
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
