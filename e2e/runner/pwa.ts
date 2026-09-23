import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { E2E_ROOT, runArtifactDir } from '../paths';
import { API_URL, CHROME_PATH } from '../web/fixtures/env';
import { parseWebCli } from './cli';
import { createRunId, waitForApi, writeJson } from './lib';
import { capture, inherit } from './process';
import { selectCases, validateCaseRegistry } from './registry';
import { assertOriginOwnedByRepo, assertPortFree } from './stack';

const REPO_ROOT = join(E2E_ROOT, '..');
const EXPORT_DIR = join(REPO_ROOT, 'apps', 'bracemark-web', 'out');
// The origin the installed app lives on. Not :3000, which the dev server holds
// during every other run; :3001 is the other origin bracemark-api's development
// CORS_ORIGINS already allows (wrangler.jsonc), and nothing in `npm run dev`
// listens there.
const PWA_URL = process.env.E2E_PWA_URL ?? 'http://localhost:3001';
// The deployed tiers' api origins. A staged export naming either is a build of
// the wrong environment, and would test nothing here — or worse, reach them.
const DEPLOYED_APIS = ['https://api.bracemark.com', 'https://api.dryrunbase.com'];

// Prove the staged export is the build this run needs: a service worker, and
// a bundle whose baked api origin is the local one.
async function assertLocalBuild(root: string): Promise<{ precacheEntries: number }> {
  const sw = await readFile(join(root, 'sw.js'), 'utf8');
  const chunksDir = join(root, '_next', 'static', 'chunks');
  const chunks = (await readdir(chunksDir)).filter((name) => name.endsWith('.js'));
  let local = false;
  for (const name of chunks) {
    const source = await readFile(join(chunksDir, name), 'utf8');
    const deployed = DEPLOYED_APIS.find((origin) => source.includes(origin));
    if (deployed)
      throw new Error(`the staged export names ${deployed} (${name}) — not a local build`);
    if (source.includes(API_URL)) local = true;
  }
  if (!local) throw new Error(`no chunk of the staged export names ${API_URL}`);
  return { precacheEntries: (sw.match(/revision/g) ?? []).length };
}

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

  // The production build (NODE_ENV=production, `serwist build` after `next
  // build`) of the DEVELOPMENT env: .env.development's origins through the
  // target's `envFile`, exactly the way `staging` gets its own
  // (docs/env-files.md). Copied out at once, so the run tests these bytes even
  // if `out/` is rebuilt meanwhile, and the run directory records them.
  const buildArgs = ['nx', 'build', '@stxapps/bracemark-web', '--configuration=development'];
  await inherit('npx', buildArgs, { cwd: REPO_ROOT });
  const staged = join(runDir, 'web-export');
  await cp(EXPORT_DIR, staged, { recursive: true });
  const build = await assertLocalBuild(staged);

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
      command: ['npx', ...buildArgs].join(' '),
      stagedExport: staged,
      precacheEntries: build.precacheEntries,
    },
    browser: { executable: CHROME_PATH, version: chromeVersion.stdout.trim() || 'unknown' },
    // Chrome installs the app (CDP PWA.install) but never opens its standalone
    // window under automation, so the app's own standalone registration trigger
    // is not exercised here — PWA-RELEASE-001 owns it.
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
