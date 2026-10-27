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
import { launchApp } from '../web/fixtures/launch';
import { grantPlusAndLoad } from '../web/fixtures/plan';
import { writeBackupLibrary } from './library';
import { calibrate, type Calibration, instrument, type LegResult, measureLeg } from './main-thread';
import { printTable } from './native';

// What scrolling the links list and docking/undocking its rail cost
// bracemark-web's main thread, per link layout — the render leg (docs/e2e.md,
// _the render leg_), beside measure/render-mobile.ts for bracemark-expo.
//
//   npm run dev                                   # the api (only it is borrowed)
//   npm run measure:render:web                    # 1,000 links, CPU 4x slower
//   npm run measure:render:web -- --cpu 6 --repeat 5 --layouts list
//   npm run measure:render:web -- --trace         # + a DevTools trace per run
//   npm run measure:render:web -- --dev           # the dev server on :3000 instead
//
// NOT A TEST, for measure/data-web.ts's reason. The production export by
// default and the CPU slowed inside each window only, for the reasons that file
// gives; the same instrument (main-thread.ts), with its positive control first.
//
// One fresh Plus account, restored from a `plus-full`-shaped backup WITH its
// preview images and left to sync to rest, then per layout:
//
//   scroll    a fast wheel scroll down the list and back up, over the list's
//             own scroller (a wheel goes to the scroller under the pointer).
//   rail      TOGGLES hide/show pairs of the docked rail. Each changes the list
//             pane's width, which re-measures every virtualized row.
//
// Beside the long tasks, each window counts DROPPED FRAMES off a
// requestAnimationFrame loop (FRAME_SCRIPT below): a scroll's jank is a run of
// frames each a little over budget, and none of them is a long task.

const EXPORT_URL = process.env.E2E_MEASURE_URL ?? 'http://localhost:3001';

const LAYOUTS = { list: 'List', card: 'Card' } as const;
type Layout = keyof typeof LAYOUTS;

// One wheel notch every frame, this far: about 12,000 px/s, a flick on a
// trackpad rather than a reading pace — the scroll that outruns the render.
const WHEEL_PX = 200;
const WHEEL_INTERVAL_MS = 16;

interface Options {
  links: number;
  layouts: Layout[];
  wheels: number;
  toggles: number;
  repeat: number;
  cpuRate: number;
  trace: boolean;
  dev: boolean;
  build: boolean;
  headed: boolean;
}

interface RenderRun extends LegResult {
  layout: Layout;
  run: number;
  droppedFrames: number;
}

// Frames counted off requestAnimationFrame: a gap of more than one and a half
// budgets is a frame (or more) the page didn't paint. A string, not a function,
// for main-thread.ts's ⚠ — a function-form init script dies on esbuild's
// `__name` helper before installing anything.
const FRAME_SCRIPT = `(() => {
  const BUDGET = 1000 / 60;
  const state = { last: 0, dropped: 0 };
  const loop = (t) => {
    if (state.last && t - state.last > BUDGET * 1.5) {
      state.dropped += Math.round((t - state.last) / BUDGET) - 1;
    }
    state.last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.__frames = {
    reset() { state.dropped = 0; state.last = 0; },
    read() { return state.dropped; },
  };
})();`;

interface FrameStore {
  reset(): void;
  read(): number;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    links: 1_000,
    layouts: ['list', 'card'],
    wheels: 60,
    toggles: 5,
    repeat: 3,
    cpuRate: 4,
    trace: false,
    dev: false,
    build: true,
    headed: false,
  };
  const count = (arg: string, raw: string) => {
    const n = Number(raw.replaceAll('_', ''));
    if (!Number.isInteger(n) || n < 1) throw new Error(`${arg} takes a positive whole number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--links') options.links = count(arg, value());
    else if (arg === '--layouts') {
      const names = value().split(',');
      const unknown = names.find((name) => !(name in LAYOUTS));
      if (unknown) throw new Error(`--layouts takes list and/or card, not ${unknown}`);
      options.layouts = names as Layout[];
    } else if (arg === '--wheels') options.wheels = count(arg, value());
    else if (arg === '--toggles') options.toggles = count(arg, value());
    else if (arg === '--repeat') options.repeat = count(arg, value());
    else if (arg === '--cpu') {
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

  const runId = createRunId('measure-render-web');
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

  const app = await launchApp(profileDir('measure-render-web'), {
    baseURL,
    headed: options.headed,
  });
  const runs: RenderRun[] = [];
  let calibration: Calibration | undefined;
  try {
    await instrument(app.context);
    await countFrames(app.context);
    await grantPlusAndLoad(app.page, app.credentials.username);
    calibration = await calibrate(app.page, options.cpuRate);
    console.log(
      `instrument check: fixed work read ${calibration.baseMs} ms at 1x, ` +
        `${calibration.slowedMs} ms at ${calibration.cpuRate}x`,
    );
    await restoreLibrary(app.page, runDir, options.links);
    for (const layout of options.layouts) {
      runs.push(...(await measureLayout(app.page, layout, runDir, options)));
    }
  } finally {
    await app.close();
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
    calibration,
    browser: chrome.stdout.trim() || 'unknown',
    links: options.links,
    wheels: options.wheels,
    toggles: options.toggles,
    checkout: { commit: commit.stdout.trim(), dirty: status.stdout.trim().length > 0 },
    runs,
  });
  report(runs);
  console.log(`\nresults: ${resultsPath}`);
}

async function countFrames(context: BrowserContext): Promise<void> {
  await context.addInitScript(FRAME_SCRIPT);
}

// A `plus-full`-shaped backup of `links` links, with its preview images,
// imported through Settings → Data and synced to rest. render-mobile.ts restores
// its device's library through this too, then signs the device in to pull it.
export async function restoreLibrary(page: Page, runDir: string, links: number): Promise<void> {
  const backup = join(runDir, `backup-${links}.zip`);
  await writeBackupLibrary(backup, links, { images: true });
  console.log(`restoring ${links.toLocaleString('en-US')} links…`);
  await page.goto('/settings/data');
  await page.getByRole('button', { name: /^Import data/ }).click();
  const receipt = page.getByText(/^Imported \d+ link/);
  const failure = page.getByText(/^Import failed:/);
  await page.locator('input[type=file]').setInputFiles(backup);
  await expect(receipt.or(failure)).toBeVisible({ timeout: 10 * 60 * 1000 });
  if (await failure.isVisible()) throw new Error(await failure.innerText());
  const started = Date.now();
  await waitForSync(page);
  console.log(`  (synced in ${((Date.now() - started) / 1000).toFixed(1)} s — not measured)`);
}

async function measureLayout(
  page: Page,
  layout: Layout,
  runDir: string,
  options: Options,
): Promise<RenderRun[]> {
  await page.goto('/settings/misc');
  const radio = page.getByRole('radio', { name: new RegExp(`^${LAYOUTS[layout]}\\b`) });
  await radio.click();
  await expect(radio).toBeChecked();
  await page.goto('/links');
  await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeVisible({
    timeout: 30_000,
  });
  // The layout write's own sync cycle, out of the first window's way.
  await page.waitForTimeout(3000);

  const runs: RenderRun[] = [];
  const measure = (leg: string, run: number) => ({
    cpuRate: options.cpuRate,
    ...(options.trace ? { tracePath: join(runDir, `${leg}-${layout}-${run}.trace.json`) } : {}),
  });
  for (let run = 1; run <= options.repeat; run++) {
    console.log(`\nscroll, ${layout} layout, run ${run}/${options.repeat}`);
    const { x, y } = await scroller(page);
    await page.mouse.move(x, y);
    runs.push(
      await framed(page, layout, run, `scroll ${layout}`, measure('scroll', run), async () => {
        for (const direction of [1, -1]) {
          for (let i = 0; i < options.wheels; i++) {
            await page.mouse.wheel(0, direction * WHEEL_PX);
            await page.waitForTimeout(WHEEL_INTERVAL_MS);
          }
          // The positive control: a clean reading is only news if the list
          // moved. A wheel over the wrong element scrolls nothing and reads 0.
          if (direction === 1) {
            const reached = (await scroller(page)).top;
            if (reached < WHEEL_PX * 10) {
              throw new Error(`the wheel scrolled the list only ${reached} px — it is not over it`);
            }
            console.log(`  (scrolled ${reached} px down)`);
          }
        }
        // Let the last notch's rows mount inside the window.
        await page.waitForTimeout(500);
      }),
    );
  }
  for (let run = 1; run <= options.repeat; run++) {
    console.log(`\nrail, ${layout} layout, run ${run}/${options.repeat}`);
    runs.push(
      await framed(page, layout, run, `rail ${layout}`, measure('rail', run), async () => {
        for (let i = 0; i < options.toggles; i++) {
          await page.getByRole('button', { name: 'Hide sidebar' }).click();
          await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible();
          await page.getByRole('button', { name: 'Show sidebar' }).click();
          await expect(page.getByRole('button', { name: 'Hide sidebar' })).toBeVisible();
        }
        await page.waitForTimeout(500);
      }),
    );
  }
  return runs;
}

// measureLeg plus the frame counter, reset as the window opens and read as it
// closes — inside the action, so the reading spans exactly the long tasks'.
async function framed(
  page: Page,
  layout: Layout,
  run: number,
  leg: string,
  measure: { cpuRate: number; tracePath?: string },
  action: () => Promise<void>,
): Promise<RenderRun> {
  let droppedFrames = 0;
  const result = await measureLeg(page, leg, measure, async () => {
    await page.evaluate(() => (window as unknown as { __frames: FrameStore }).__frames.reset());
    await action();
    droppedFrames = await page.evaluate(() =>
      (window as unknown as { __frames: FrameStore }).__frames.read(),
    );
    return `${droppedFrames} dropped frames`;
  });
  console.log(
    `  ${droppedFrames} dropped frames, longest task ${result.longestTaskMs} ms, ` +
      `blocking ${result.blockingMs} ms`,
  );
  return { ...result, layout, run, droppedFrames };
}

// The links pane's scroller — its centre, and how far down it is: the element
// that scrolls furthest. Both layouts own one (list-layout.tsx, card-layout.tsx)
// and neither carries a test id, and a wheel goes to whatever scroller is under
// the pointer, so this finds it by what it does rather than by its classes.
async function scroller(page: Page): Promise<{ x: number; y: number; top: number }> {
  const found = await page.evaluate(() => {
    let best: Element | null = null;
    let reach = 0;
    for (const element of Array.from(document.querySelectorAll('*'))) {
      const overflow = getComputedStyle(element).overflowY;
      if (overflow !== 'auto' && overflow !== 'scroll') continue;
      const extra = element.scrollHeight - element.clientHeight;
      if (extra > reach) {
        reach = extra;
        best = element;
      }
    }
    if (!best) return null;
    const box = best.getBoundingClientRect();
    return {
      x: box.left + box.width / 2,
      y: box.top + box.height / 2,
      top: Math.round(best.scrollTop),
    };
  });
  if (!found) throw new Error('no scrolling links pane on the page');
  return found;
}

// --- the report ---------------------------------------------------------------------

function report(runs: RenderRun[]): void {
  printTable(
    ['leg', 'run', 'dropped frames', 'longest task', 'blocking', 'long tasks'],
    runs.map((run) => [
      run.leg,
      String(run.run),
      String(run.droppedFrames),
      `${run.longestTaskMs} ms`,
      `${run.blockingMs} ms`,
      String(run.longTasks),
    ]),
  );
  const framed = runs.filter((run) => run.worstFrame);
  if (framed.length > 0) console.log('\nthe frame that blocked longest, per run:');
  for (const run of framed) {
    if (!run.worstFrame) continue;
    console.log(`  ${run.leg} #${run.run}: ${run.worstFrame.blockingMs} ms blocking`);
    for (const script of run.worstFrame.scripts) console.log(`    ${script}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
