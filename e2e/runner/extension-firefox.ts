import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { firefox } from '@playwright/test';

import { buildExtension } from '../extension/fixtures/extension';
import { E2E_ROOT, runArtifactDir } from '../paths';
import { parseWebCli } from './cli';
import { IS_STAGING } from './environment';
import { createRunId, writeJson } from './lib';
import { capture, inherit } from './process';
import { selectCases, validateCaseRegistry } from './registry';

// `e2e-extension:firefox`: the browser-extension cases that only Firefox can answer
// (a registry entry with `browsers: ["firefox"]`). Playwright loads no extension into
// Firefox, so these don't share e2e-extension's popup harness: each case launches
// Playwright's pinned Firefox through Marionette and drives the Firefox build's own
// scripts against pages it serves itself (extension/firefox/fixture.ts). So there is
// no stack to check and no account: the run works with `npm run dev` down, and it is
// local-only by construction. docs/e2e.md, _the Firefox browser-extension target_.
async function main(): Promise<void> {
  validateCaseRegistry();
  if (IS_STAGING) {
    throw new Error('the Firefox browser-extension cases serve their own pages: run them locally');
  }
  const options = parseWebCli();
  if (
    options.playwrightArgs.some(
      (argument) => argument === '--grep' || argument.startsWith('--grep='),
    )
  ) {
    throw new Error(
      'use --case/--suite/--include-trait/--omit-trait; do not combine them with --grep',
    );
  }
  const selected = selectCases('extension', { ...options, browser: 'firefox' });

  const firefoxPath = firefox.executablePath();
  if (!existsSync(firefoxPath)) {
    throw new Error(
      'Playwright’s Firefox is not installed. Run `npx playwright install firefox` and retry.',
    );
  }

  const runId = createRunId('extension-firefox');
  const runDir = runArtifactDir(runId);
  await mkdir(runDir, { recursive: true });
  const build = buildExtension('firefox');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_RUN_ID: runId,
    E2E_RUN_DIR: runDir,
    E2E_FIREFOX_EXTENSION_BUILD: build,
  };
  const grep = selected.map((testCase) => `@${testCase.id}(?=\\s|$)`).join('|');
  const args = [
    'test',
    '--config',
    'extension-firefox.playwright.config.ts',
    '--grep',
    grep,
    ...options.playwrightArgs,
  ];
  const [playwrightVersion, firefoxVersion, commit, status] = await Promise.all([
    capture('playwright', ['--version'], { cwd: E2E_ROOT, env }),
    capture(firefoxPath, ['--version']),
    capture('git', ['rev-parse', 'HEAD'], { cwd: join(E2E_ROOT, '..') }),
    capture('git', ['status', '--porcelain'], { cwd: join(E2E_ROOT, '..') }),
  ]);
  const manifestPath = join(runDir, 'run.json');
  const manifest = {
    schemaVersion: 1,
    runId,
    kind: 'extension-firefox',
    environment: 'local',
    status: 'running',
    startedAt: new Date().toISOString(),
    suite: options.suite,
    filters: {
      cases: options.cases,
      includeTraits: options.includeTraits,
      excludeTraits: options.excludeTraits,
    },
    selectedCases: selected.map((testCase) => testCase.id),
    build: { mode: 'firefox', source: build },
    browser: {
      executable: firefoxPath,
      version: firefoxVersion.stdout.trim(),
      bundled: true,
      driver: 'marionette',
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

  try {
    await inherit('playwright', args, { cwd: E2E_ROOT, env });
    manifest.status = 'passed';
  } catch (error) {
    manifest.status = 'failed';
    throw error;
  } finally {
    manifest.finishedAt = new Date().toISOString();
    await writeJson(manifestPath, manifest);
    console.log(`extension Firefox E2E artifacts: ${runDir}`);
  }
}

await main();
