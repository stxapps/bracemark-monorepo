import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type BrowserContext, expect, type Page } from '@playwright/test';

import { E2E_ROOT, MEASURE_OUTPUT, profileDir } from '../paths';
import { type StaticOrigin, staticOrigin } from '../pwa/fixtures/origin';
import { createRunId, waitForApi, writeJson } from '../runner/lib';
import { capture } from '../runner/process';
import { assertOriginOwnedByRepo, assertPortFree } from '../runner/stack';
import { stageLocalWebExport } from '../runner/web-export';
import { waitForSync } from '../seed/steps';
import { API_URL, CHROME_PATH, WEB_URL } from '../web/fixtures/env';
import { launchApp, type LaunchedApp } from '../web/fixtures/launch';
import { grantPlusAndLoad } from '../web/fixtures/plan';
import { writeBackupLibrary, writeBookmarksHtml } from './library';
import {
  band,
  calibrate,
  type Calibration,
  instrument,
  type LegResult,
  measureLeg,
  type MeasureOptions,
} from './main-thread';

// How long import and export hold bracemark-web's main thread, at library sizes
// you pick — the measurement behind docs/data-lifecycle.md, _main-thread cost_,
// and the thing to re-run before deciding that a step of either belongs in a Web
// Worker.
//
//   npm run dev                                   # the api (only it is borrowed)
//   npm run measure:data                          # 10,000 links, 4x CPU slowdown
//   npm run measure:data -- --links 10000,50000 --cpu 6
//   npm run measure:data -- --trace               # + a DevTools trace per leg
//   npm run measure:data -- --dev                 # the dev server on :3000 instead
//
// NOT A TEST, and deliberately not in any suite. A pass/fail threshold on timing
// from a dev machine running the whole local stack either flaps or is set so
// loose it never fires. What this produces is numbers, for a person to read
// against the thresholds in the doc and record there with the date and machine.
//
// Per size, six legs on two fresh Plus accounts (Plus because free caps a
// library at 200 links):
//
//   import HTML      a browser-style bookmarks file — the interop path: parse,
//                    dedupe, find-or-create lists and tags, chunked writes.
//   import backup    a Bracemark backup of a realistic library — the restore
//                    path: items.jsonl split and classified line by line.
//   export ×4        HTML bookmarks, CSV, plain text and the Bracemark backup,
//                    from the restored library once it has synced.
//
// THE PRODUCTION EXPORT BY DEFAULT. React's development build does several
// times the main-thread work of the production one, so the dev server overstates
// every number here; the run builds the export against the local api
// (runner/web-export.ts, the PWA runner's build) and serves it on :3001 itself.
// `--dev` measures the dev server anyway, for readable function names — label
// what you record accordingly.
//
// THE CPU IS SLOWED, and only inside each leg's window. A developer's laptop is
// the fastest machine this app will ever run on; the slowdown stands in for the
// mid-range phone browser a user imports from. Account creation (Argon2id) and
// the unmeasured waits between legs run at full speed.
//
// EXPORT TAKES THE DOWNLOAD PATH, not the save dialog. `exportAllData` claims
// its destination through `showSaveFilePicker`, a native dialog Playwright
// cannot drive (docs/e2e.md, _what e2e may not assert_). Removing it before the
// app loads sends the backup down the fallback Safari and Firefox take
// (`downloadBlob`) — a real product path, not a stub, and the same main-thread
// work: gather, serialize, zip. Only where the bytes land differs.

// :3001 is the other origin bracemark-api's development CORS_ORIGINS allows
// (wrangler.jsonc); the PWA runner serves its export there for the same reason.
const EXPORT_URL = process.env.E2E_MEASURE_URL ?? 'http://localhost:3001';

// Per-leg ceiling. A 50,000-link import at 6x is minutes, not seconds.
const LEG_TIMEOUT_MS = 30 * 60 * 1000;

const EXPORT_FORMATS = [
  { format: 'netscape', label: 'HTML bookmarks' },
  { format: 'csv', label: 'CSV' },
  { format: 'text', label: 'Plain text' },
  { format: 'bracemark', label: 'Bracemark backup' },
] as const;

interface Options {
  links: number[];
  cpuRate: number;
  trace: boolean;
  dev: boolean;
  build: boolean;
  headed: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    links: [10_000],
    cpuRate: 4,
    trace: false,
    dev: false,
    build: true,
    headed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--links') {
      options.links = value()
        .split(',')
        .map((part) => Number(part.replaceAll('_', '')));
      if (options.links.some((n) => !Number.isInteger(n) || n < 1)) {
        throw new Error('--links takes positive whole numbers, comma-separated');
      }
    } else if (arg === '--cpu') {
      options.cpuRate = Number(value());
      if (!(options.cpuRate >= 1)) throw new Error('--cpu takes a slowdown factor of 1 or more');
    } else if (arg === '--trace') options.trace = true;
    else if (arg === '--dev') options.dev = true;
    else if (arg === '--skip-build') options.build = false;
    else if (arg === '--headed') options.headed = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await waitForApi();
  await assertOriginOwnedByRepo(API_URL, 'bracemark-api', { required: true });

  const runId = createRunId('measure-data');
  const runDir = join(MEASURE_OUTPUT, runId);
  await mkdir(runDir, { recursive: true });

  let baseURL = WEB_URL;
  let origin: StaticOrigin | undefined;
  if (options.dev) {
    await assertOriginOwnedByRepo(WEB_URL, 'bracemark-web', { required: true });
  } else {
    await assertPortFree(EXPORT_URL, 'the measured export’s origin');
    const staged = await stageLocalWebExport(runDir, { build: options.build });
    origin = staticOrigin(staged.root, EXPORT_URL);
    await origin.start();
    baseURL = EXPORT_URL;
  }
  const target = options.dev ? `dev server (${baseURL})` : `production export (${baseURL})`;
  console.log(`measuring ${target}, CPU ${options.cpuRate}x slower, into ${runDir}`);

  const results: LegResult[] = [];
  const calibrations: Calibration[] = [];
  try {
    for (const links of options.links) {
      const size = await measureSize(links, runDir, baseURL, options);
      calibrations.push(size.calibration);
      results.push(...size.results);
    }
  } finally {
    await origin?.stop();
  }

  const [chrome, commit, status] = await Promise.all([
    capture(CHROME_PATH, ['--version'], { allowFailure: true }),
    capture('git', ['rev-parse', 'HEAD'], { cwd: join(E2E_ROOT, '..') }),
    capture('git', ['status', '--porcelain'], { cwd: join(E2E_ROOT, '..') }),
  ]);
  const resultsPath = await writeJson(join(runDir, 'results.json'), {
    runId,
    measuredAt: new Date().toISOString(),
    target,
    cpuRate: options.cpuRate,
    calibrations,
    browser: chrome.stdout.trim() || 'unknown',
    checkout: { commit: commit.stdout.trim(), dirty: status.stdout.trim().length > 0 },
    results,
  });
  report(results);
  console.log(`\nresults: ${resultsPath}`);
}

async function measureSize(
  links: number,
  runDir: string,
  baseURL: string,
  options: Options,
): Promise<{ calibration: Calibration; results: LegResult[] }> {
  const count = links.toLocaleString('en-US');
  const html = join(runDir, `bookmarks-${links}.html`);
  const backup = join(runDir, `backup-${links}.zip`);
  await writeBookmarksHtml(html, links);
  await writeBackupLibrary(backup, links);
  const measure = (leg: string): MeasureOptions => ({
    cpuRate: options.cpuRate,
    ...(options.trace ? { tracePath: join(runDir, `${slug(leg)}-${links}.trace.json`) } : {}),
  });
  const results: LegResult[] = [];
  let calibration: Calibration;

  // The interop import gets an account of its own: an empty library, like the
  // one a person moving from another app starts with.
  const interop = await openAccount(`measure-interop-${links}`, baseURL, options);
  try {
    // Nothing below is believed until the instrument has seen a known stall on
    // this machine, at this slowdown (main-thread.ts, `calibrate`).
    calibration = await calibrate(interop.page, options.cpuRate);
    console.log(
      `instrument check: fixed work read ${calibration.baseMs} ms at 1x, ` +
        `${calibration.slowedMs} ms at ${calibration.cpuRate}x`,
    );
    const leg = `import HTML (${count})`;
    results.push(await importLeg(interop.page, leg, html, measure(leg)));
  } finally {
    await interop.close();
  }

  const restore = await openAccount(`measure-restore-${links}`, baseURL, options);
  try {
    const leg = `import backup (${count})`;
    results.push(await importLeg(restore.page, leg, backup, measure(leg)));

    // Export from a library at rest. Straight after a restore the sync engine is
    // still pushing every entity it wrote, and an export's own opening refresh
    // would wait on that — a state nobody exports from, and one that measures
    // the push rather than the export. Unmeasured, and at full speed.
    const syncStarted = Date.now();
    await waitForSync(restore.page);
    console.log(`  (the restore synced in ${seconds(Date.now() - syncStarted)} — not measured)`);

    for (const option of EXPORT_FORMATS) {
      const leg = `export ${option.label} (${count})`;
      const savePath = join(runDir, `export-${option.format}-${links}`);
      results.push(await exportLeg(restore.page, leg, option.label, savePath, measure(leg)));
    }
  } finally {
    await restore.close();
  }
  return { calibration, results };
}

async function openAccount(name: string, baseURL: string, options: Options): Promise<LaunchedApp> {
  const app = await launchApp(profileDir(name), { baseURL, headed: options.headed });
  try {
    await withoutSavePicker(app.context);
    await instrument(app.context);
    await grantPlusAndLoad(app.page, app.credentials.username);
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}

// See EXPORT TAKES THE DOWNLOAD PATH above. Checked at every export, because a
// Chrome that moved the method onto the prototype would make this a silent
// no-op and the leg would hang on a dialog nobody can see.
async function withoutSavePicker(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    delete (window as Partial<Record<'showSaveFilePicker', unknown>>).showSaveFilePicker;
  });
}

async function importLeg(
  page: Page,
  leg: string,
  file: string,
  measure: MeasureOptions,
): Promise<LegResult> {
  console.log(`\n${leg}`);
  await page.goto('/settings/data');
  await page.getByRole('button', { name: /^Import data/ }).click();
  const receipt = page.getByText(/^Imported \d+ link/);
  const failure = page.getByText(/^Import failed:/);

  const result = await measureLeg(page, leg, measure, async () => {
    await page.locator('input[type=file]').setInputFiles(file);
    await expect(receipt.or(failure)).toBeVisible({ timeout: LEG_TIMEOUT_MS });
    if (await failure.isVisible()) throw new Error(await failure.innerText());
    return (await receipt.innerText()).trim();
  });
  console.log(`  ${result.receipt}`);
  return result;
}

async function exportLeg(
  page: Page,
  leg: string,
  label: string,
  savePath: string,
  measure: MeasureOptions,
): Promise<LegResult> {
  console.log(`\n${leg}`);
  await page.goto('/settings/data');
  if (await page.evaluate(() => 'showSaveFilePicker' in window)) {
    throw new Error(
      'showSaveFilePicker is still on window — the export would open a native dialog',
    );
  }
  await page.getByRole('button', { name: /^Export all data/ }).click();
  const radio = page.getByRole('radio', { name: new RegExp(`^${label}\\b`) });
  await radio.click();
  await expect(radio).toBeChecked();
  const receipt = page.getByText(/^Exported \d+ link/);
  const failure = page.getByText(/^Export failed:/);

  const downloaded = page.waitForEvent('download', { timeout: LEG_TIMEOUT_MS });
  // Observed below on success; on a failure the leg throws first, and this
  // rejection must not surface as an unhandled one on top of it.
  downloaded.catch(() => undefined);
  const result = await measureLeg(page, leg, measure, async () => {
    await page.getByRole('button', { name: 'Export all data', exact: true }).click();
    await expect(receipt.or(failure)).toBeVisible({ timeout: LEG_TIMEOUT_MS });
    if (await failure.isVisible()) throw new Error(await failure.innerText());
    return (await receipt.innerText()).trim();
  });
  const download = await downloaded;
  await download.saveAs(`${savePath}-${download.suggestedFilename()}`);
  console.log(`  ${result.receipt}`);
  return result;
}

// --- the report ---------------------------------------------------------------------

function report(results: LegResult[]): void {
  const rows = results.map((result) => [
    result.leg,
    seconds(result.wallMs),
    `${result.longestTaskMs.toLocaleString('en-US')} ms`,
    `${result.blockingMs.toLocaleString('en-US')} ms`,
    String(result.longTasks),
    band(result.longestTaskMs),
  ]);
  const header = ['leg', 'wall', 'longest task', 'blocking', 'long tasks', 'band'];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join('  ');

  console.log(`\n${line(header)}`);
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));

  const framed = results.filter((result) => result.worstFrame);
  if (framed.length > 0) console.log('\nthe frame that blocked longest, per leg:');
  for (const result of framed) {
    const frame = result.worstFrame;
    if (!frame) continue;
    console.log(`  ${result.leg}: ${frame.blockingMs.toLocaleString('en-US')} ms blocking`);
    for (const script of frame.scripts) console.log(`    ${script}`);
  }
  const traces = results.filter((result) => result.tracePath);
  if (traces.length > 0) {
    console.log('\ntraces (DevTools → Performance → Load profile):');
    for (const result of traces) console.log(`  ${result.tracePath}`);
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/\(.*\)/, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '-');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
