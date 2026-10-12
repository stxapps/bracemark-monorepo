import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { E2E_ROOT, runArtifactDir } from '../paths';
import { API_URL, CHROME_PATH, EXTRACTOR_URL, WEB_URL } from '../web/fixtures/env';
import { parseVisualCli, type VisualCliOptions } from './cli';
import { readDeviceLook, restoreDeviceLook, setAppearance } from './device-look';
import { requireLocalEnvironment } from './environment';
import { createRunId, writeJson } from './lib';
import { prepareNativeRun } from './native-run';
import { capture, inherit } from './process';
import { selectCases, selectCasesForPlatform, validateCaseRegistry } from './registry';
import { assertStackOwnedByRepo } from './stack';
import { clearStatusBar, freezeStatusBar } from './status-bar';
import { compareVisualRun } from './visual-compare';
import { runVisualNativeCase } from './visual-native';

// The visual checkpoints (docs/e2e.md, _visual checkpoints_): capture every
// named checkpoint e2e/visual.json owes the selected cases on one platform, then
// compare them with this machine's accepted baseline and write a report.
//
//   npm run e2e:visual:web
//   npm run e2e:visual:ios                       (the one booted simulator)
//   npm run e2e:visual:android -- --device <serial> --accept
//
// Review-only: a changed capture is reported, not failed, unless its checkpoint
// is gated. `--accept` makes a passing run's captures the baseline.

async function runWeb(options: VisualCliOptions): Promise<void> {
  const selected = selectCases('web', { ...options, baseline: true });
  await assertStackOwnedByRepo([
    { origin: WEB_URL, label: 'bracemark-web', required: true },
    { origin: API_URL, label: 'bracemark-api', required: true },
    { origin: EXTRACTOR_URL, label: 'bracemark-extractor', required: true },
  ]);

  const runId = createRunId('visual-web');
  const runDir = runArtifactDir(runId);
  await mkdir(runDir, { recursive: true });
  const env = { ...process.env, E2E_RUN_ID: runId, E2E_RUN_DIR: runDir };
  const args = [
    'test',
    '--config',
    'visual.playwright.config.ts',
    '--grep',
    selected.map((testCase) => `@${testCase.id}`).join('|'),
  ];
  const [playwrightVersion, chromeVersion, commit, status] = await Promise.all([
    capture('playwright', ['--version'], { cwd: E2E_ROOT, env }),
    capture(CHROME_PATH, ['--version'], { allowFailure: true }),
    capture('git', ['rev-parse', 'HEAD'], { cwd: join(E2E_ROOT, '..') }),
    capture('git', ['status', '--porcelain'], { cwd: join(E2E_ROOT, '..') }),
  ]);
  const chrome = chromeVersion.stdout.trim() || 'unknown';
  const manifestPath = join(runDir, 'run.json');
  const manifest = {
    schemaVersion: 1,
    runId,
    kind: 'visual-web',
    status: 'running',
    startedAt: new Date().toISOString(),
    filters: {
      cases: options.cases,
      includeTraits: options.includeTraits,
      excludeTraits: options.excludeTraits,
    },
    selectedCases: selected.map((testCase) => testCase.id),
    origins: { web: WEB_URL, api: API_URL },
    browser: { executable: CHROME_PATH, version: chrome },
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

  let captured = false;
  try {
    await inherit('playwright', args, { cwd: E2E_ROOT, env });
    captured = true;
  } finally {
    // Compared even after a failure, so the report shows what WAS captured and
    // names what was not; `--accept` needs the whole run.
    const { failed } = await compareVisualRun({
      runId,
      runDir,
      profile: 'web-chrome',
      platform: 'web',
      caseIds: selected.map((testCase) => testCase.id),
      accept: options.accept && captured,
    });
    manifest.status = captured && !failed ? 'passed' : 'failed';
    manifest.finishedAt = new Date().toISOString();
    await writeJson(manifestPath, manifest);
    console.log(`visual E2E artifacts: ${runDir}`);
    if (captured && failed) process.exitCode = 1;
  }
}

async function runNative(options: VisualCliOptions & { platform: 'ios' | 'android' }) {
  const selected = selectCasesForPlatform('native', options.platform, {
    ...options,
    baseline: true,
  });
  const run = await prepareNativeRun('visual', options, selected);

  // Put the device the way every capture assumes — frozen status bar, light,
  // the found text size — and back the way it was found, whatever happens.
  const found = await readDeviceLook(run.platform, run.deviceId);
  let captured = false;
  try {
    await freezeStatusBar(run.platform, run.deviceId);
    await setAppearance(run.platform, run.deviceId, 'light');
    for (const testCase of selected) await runVisualNativeCase(run, testCase, found);
    captured = true;
  } finally {
    await restoreDeviceLook(run.platform, run.deviceId, found);
    await clearStatusBar(run.platform, run.deviceId).catch((error) =>
      console.warn(`could not clear the ${run.platform} status bar: ${String(error)}`),
    );
    const { device } = run;
    const { failed } = await compareVisualRun({
      runId: run.runId,
      runDir: run.runDir,
      profile: `${run.platform}-${device.model}-${device.osVersion}`,
      platform: run.platform,
      caseIds: selected.map((testCase) => testCase.id),
      accept: options.accept && captured,
    });
    await run.finish(captured && !failed ? 'passed' : 'failed');
    if (captured && failed) process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  requireLocalEnvironment('visual E2E');
  validateCaseRegistry();
  const options = parseVisualCli();
  if (options.platform === 'web') await runWeb(options);
  else await runNative({ ...options, platform: options.platform });
}

await main();
