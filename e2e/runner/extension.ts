import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

import { buildExtension, stageExtensionCopy } from '../extension/fixtures/extension';
import { E2E_ROOT, runArtifactDir } from '../paths';
import { proveStagingPlanAccess } from '../seed/d1';
import { API_URL, WEB_URL } from '../web/fixtures/env';
import { parseWebCli } from './cli';
import { E2E_ENVIRONMENT, E2E_ORIGINS, IS_STAGING } from './environment';
import { assertExtensionBundle } from './extension-bundle';
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
  const selected = selectCases('extension', { ...options, environment: E2E_ENVIRONMENT });

  // Before the browser extension is built: the stack is `npm run dev`'s. Staging
  // origins are not local and pass through.
  await assertStackOwnedByRepo([
    { origin: WEB_URL, label: 'bracemark-web', required: true },
    { origin: API_URL, label: 'bracemark-api', required: true },
  ]);

  const chromiumPath = chromium.executablePath();
  if (!existsSync(chromiumPath)) {
    throw new Error(
      'Playwright Chromium is not installed. Run `npx playwright install chromium` and retry.',
    );
  }

  // The same preflight, the same credential and the same mark as runner/web.ts:
  // a selected case that grants a plan writes one row to staging's remote D1
  // (seed/d1.ts), so the token is proved before a run directory exists or an
  // account is created. A run with no such case never touches the keychain.
  const stagingGrants = selected.filter((testCase) => testCase.stagingGrants?.includes('plan'));
  const stagingPlanFrom =
    IS_STAGING && stagingGrants.length > 0 ? await proveStagingPlanAccess() : undefined;

  const runId = createRunId(IS_STAGING ? 'staging-extension' : 'extension');
  const runDir = runArtifactDir(runId);
  await mkdir(runDir, { recursive: true });

  // Local drives the development build against `npm run dev`; staging drives the
  // bundle built for dryrunbase.com. Either must answer the run's own tier before
  // it is staged (extension-bundle.ts).
  const buildMode = IS_STAGING ? 'staging' : 'development';
  const build = buildExtension(buildMode);
  await assertExtensionBundle(build, E2E_ENVIRONMENT, E2E_ORIGINS);
  const staged = await stageExtensionCopy(join(runDir, 'extension-staged'), {
    source: build,
    permissions: ['tabs'],
  });
  const extractionStaged = await stageExtensionCopy(join(runDir, 'extension-extraction-staged'), {
    source: build,
    permissions: ['tabs'],
    // Only the controlled page used by EXT-EXTRACT-001, on the run's web origin.
    // This substitutes for the toolbar-created activeTab grant; release
    // qualification owns that browser-chrome boundary.
    hostPermissions: [`${new URL(WEB_URL).origin}/*`],
  });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_RUN_ID: runId,
    E2E_RUN_DIR: runDir,
    E2E_EXTENSION_PATH: staged,
    E2E_EXTENSION_EXTRACTION_PATH: extractionStaged,
  };
  if (stagingPlanFrom) {
    console.log(
      `staging plan grants: ${stagingGrants.map((testCase) => testCase.id).join(', ')} — ` +
        `token from ${stagingPlanFrom}`,
    );
    env[STAGING_PLAN_GRANTS] = '1';
  }
  const grep = selected.map((testCase) => `@${testCase.id}(?=\\s|$)`).join('|');
  const args = [
    'test',
    '--config',
    'extension.playwright.config.ts',
    '--grep',
    grep,
    ...options.playwrightArgs,
  ];
  const [playwrightVersion, chromiumVersion, commit, status] = await Promise.all([
    capture('playwright', ['--version'], { cwd: E2E_ROOT, env }),
    capture(chromiumPath, ['--version']),
    capture('git', ['rev-parse', 'HEAD'], { cwd: join(E2E_ROOT, '..') }),
    capture('git', ['status', '--porcelain'], { cwd: join(E2E_ROOT, '..') }),
  ]);
  const manifestPath = join(runDir, 'run.json');
  const manifest = {
    schemaVersion: 1,
    runId,
    kind: 'extension',
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
              entry.surface === 'extension' &&
              !(entry.environments ?? ['local']).includes('staging'),
          )
          .map((entry) => entry.id)
      : [],
    build: { mode: buildMode, source: build },
    browser: {
      executable: chromiumPath,
      version: chromiumVersion.stdout.trim(),
      bundled: true,
    },
    stagedManifestDifferences: {
      default: { permissions: ['tabs'] },
      extraction: {
        permissions: ['tabs'],
        hostPermissions: [`${new URL(WEB_URL).origin}/*`],
      },
      activeTabToolbarGrantProven: false,
    },
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
  await writeJson(join(E2E_ROOT, '.artifacts', 'latest-extension-run.json'), { runId, runDir });

  try {
    await inherit('playwright', args, { cwd: E2E_ROOT, env });
    manifest.status = 'passed';
  } catch (error) {
    manifest.status = 'failed';
    throw error;
  } finally {
    manifest.finishedAt = new Date().toISOString();
    await writeJson(manifestPath, manifest);
    console.log(`extension E2E artifacts: ${runDir}`);
  }
}

await main();
