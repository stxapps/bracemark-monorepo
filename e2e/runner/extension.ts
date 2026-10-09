import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

import { buildDevelopmentExtension, stageExtensionCopy } from '../extension/fixtures/extension';
import { E2E_ROOT, runArtifactDir } from '../paths';
import { API_URL, WEB_URL } from '../web/fixtures/env';
import { parseWebCli } from './cli';
import { requireLocalEnvironment } from './environment';
import { createRunId, writeJson } from './lib';
import { capture, inherit } from './process';
import { selectCases, validateCaseRegistry } from './registry';
import { assertStackOwnedByRepo } from './stack';

async function main(): Promise<void> {
  requireLocalEnvironment('extension E2E');
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
  const selected = selectCases('extension', options);

  await assertStackOwnedByRepo([
    { origin: WEB_URL, label: 'bracemark-web' },
    { origin: API_URL, label: 'bracemark-api' },
  ]);

  const chromiumPath = chromium.executablePath();
  if (!existsSync(chromiumPath)) {
    throw new Error(
      'Playwright Chromium is not installed. Run `npx playwright install chromium` and retry.',
    );
  }

  const runId = createRunId('extension');
  const runDir = runArtifactDir(runId);
  await mkdir(runDir, { recursive: true });

  buildDevelopmentExtension();
  const staged = await stageExtensionCopy(join(runDir, 'extension-staged'), {
    permissions: ['tabs'],
  });
  const extractionStaged = await stageExtensionCopy(join(runDir, 'extension-extraction-staged'), {
    permissions: ['tabs'],
    // Only the controlled local page used by EXT-EXTRACT-001. This substitutes
    // for the toolbar-created activeTab grant; release qualification owns that
    // browser-chrome boundary.
    hostPermissions: [`${new URL(WEB_URL).origin}/*`],
  });

  const env = {
    ...process.env,
    E2E_RUN_ID: runId,
    E2E_RUN_DIR: runDir,
    E2E_EXTENSION_PATH: staged,
    E2E_EXTENSION_EXTRACTION_PATH: extractionStaged,
  };
  const grep = selected.map((testCase) => `@${testCase.id}`).join('|');
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
    status: 'running',
    startedAt: new Date().toISOString(),
    suite: options.suite,
    filters: {
      cases: options.cases,
      includeTraits: options.includeTraits,
      excludeTraits: options.excludeTraits,
    },
    selectedCases: selected.map((testCase) => testCase.id),
    origins: { web: WEB_URL, api: API_URL },
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
