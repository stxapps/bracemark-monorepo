import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { E2E_ROOT, runArtifactDir } from '../paths';
import { API_URL, CHROME_PATH } from '../web/fixtures/env';
import { parseWebCli } from './cli';
import { createRunId, waitForApi, writeJson } from './lib';
import { capture, inherit } from './process';
import { selectCases, validateCaseRegistry } from './registry';
import { assertOriginOwnedByRepo, assertPortFree } from './stack';
import { stageLocalWebExport, WEB_EXPORT_BUILD } from './web-export';

const REPO_ROOT = join(E2E_ROOT, '..');
// The origin the installed app lives on. Not :3000, which the dev server holds
// during every other run; :3001 is the other origin bracemark-api's development
// CORS_ORIGINS already allows (wrangler.jsonc), and nothing in `npm run dev`
// listens there.
const PWA_URL = process.env.E2E_PWA_URL ?? 'http://localhost:3001';

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
  const selected = selectCases('pwa', options);

  // The api is borrowed and must be this checkout's; the web origin is the
  // spec's own, so its port must be free before anything is built.
  await waitForApi();
  await assertOriginOwnedByRepo(API_URL, 'bracemark-api', { required: true });
  await assertPortFree(PWA_URL, 'the PWA origin');

  const runId = createRunId('pwa');
  const runDir = runArtifactDir(runId);
  await mkdir(runDir, { recursive: true });

  // The production build of the development env, staged into the run directory
  // (runner/web-export.ts).
  const build = await stageLocalWebExport(runDir);
  const staged = build.root;

  const env = {
    ...process.env,
    E2E_RUN_ID: runId,
    E2E_RUN_DIR: runDir,
    E2E_WEB_URL: PWA_URL,
    E2E_PWA_ROOT: staged,
  };
  const grep = selected.map((testCase) => `@${testCase.id}`).join('|');
  const args = [
    'test',
    '--config',
    'pwa.playwright.config.ts',
    '--grep',
    grep,
    ...options.playwrightArgs,
  ];
  const [playwrightVersion, chromeVersion, commit, status] = await Promise.all([
    capture('playwright', ['--version'], { cwd: E2E_ROOT, env }),
    capture(CHROME_PATH, ['--version'], { allowFailure: true }),
    capture('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT }),
    capture('git', ['status', '--porcelain'], { cwd: REPO_ROOT }),
  ]);
  const manifestPath = join(runDir, 'run.json');
  const manifest = {
    schemaVersion: 1,
    runId,
    kind: 'pwa',
    status: 'running',
    startedAt: new Date().toISOString(),
    suite: options.suite,
    filters: {
      cases: options.cases,
      includeTraits: options.includeTraits,
      excludeTraits: options.excludeTraits,
    },
    selectedCases: selected.map((testCase) => testCase.id),
    origins: { web: PWA_URL, api: API_URL },
    build: {
      command: ['npx', ...WEB_EXPORT_BUILD].join(' '),
      stagedExport: staged,
      precacheEntries: build.precacheEntries,
    },
    browser: { executable: CHROME_PATH, version: chromeVersion.stdout.trim() || 'unknown' },
    // Chrome installs the app (CDP PWA.install) but never opens its standalone
    // window under automation. Registration does not need that window — the app
    // registers at sign-in in any display mode (PWA-004) — so what is unproven
    // here is the install surface and the window itself: PWA-RELEASE-001's.
    standaloneWindowProven: false,
    playwrightVersion: playwrightVersion.stdout.trim(),
    checkout: {
      root: REPO_ROOT,
      commit: commit.stdout.trim(),
      dirty: status.stdout.trim().length > 0,
    },
    command: { command: 'playwright', args },
    finishedAt: undefined as string | undefined,
  };
  await writeJson(manifestPath, manifest);
  await writeJson(join(E2E_ROOT, '.artifacts', 'latest-pwa-run.json'), { runId, runDir });

  try {
    await inherit('playwright', args, { cwd: E2E_ROOT, env });
    manifest.status = 'passed';
  } catch (error) {
    manifest.status = 'failed';
    throw error;
  } finally {
    manifest.finishedAt = new Date().toISOString();
    await writeJson(manifestPath, manifest);
    console.log(`PWA E2E artifacts: ${runDir}`);
  }
}

await main();
