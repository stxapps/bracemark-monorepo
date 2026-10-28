import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';

import { E2E_ROOT } from '../paths';
import { type NativePlatform } from '../runner/cli';
import { findNodes, parseHierarchy } from '../runner/hierarchy';
import { maestro, maestroHierarchy } from '../runner/lib';
import { capture } from '../runner/process';
import { assertPortFree } from '../runner/stack';
import { API_URL, SITE_URL } from '../web/fixtures/env';

// What the native measurement runners share — measure/data-mobile.ts (the data
// path) and measure/render-mobile.ts (the links list): the bundle they measure,
// the device checks, and the one instrument, read back off the screen.
//
// THE INSTRUMENT is expo-react's stall probe (lib/stall-probe.ts): a 16 ms timer
// whose lateness is the JS thread's blocking, windowed by whatever the leg
// measures, and rendered as `measure-stall-reading` text that `readProbe` reads
// off the accessibility tree. It is compiled in only when the bundle is built
// with EXPO_PUBLIC_MEASURE_STALLS=1, which `startMetro` sets.
//
// A PRODUCTION BUNDLE ON THE DEVELOPMENT CLIENT, and why not a release build. A
// release build bakes its api origin, and against localhost it is unsupported
// (docs/env-files.md, _bracemark-expo_: Android refuses cleartext) — the only
// release build that could run this is a staging one, which would push tens of
// thousands of links into a deployed tier. So the installed dev client loads a
// bundle Metro serves with `--no-dev --minify`: __DEV__ off, React's production
// build, Hermes, minified — the JS a release build runs. Only the native shell is
// the debug one, and the probe measures the JS THREAD — which is not quite "JS":
// React Native's commit (Fabric's `completeRoot`: shadow-tree diff and Yoga
// layout) is C++ that runs on that thread, and the debug shell builds it
// unoptimized. A leg dominated by commits (the render leg's scroll and rail)
// therefore reads high against a release build; the data path, which is
// interpreted JS, barely moves. Compare runs with runs on one build.
//
// ⚠ `--no-dev` MAKES METRO LOAD `.env.production`, which names the PRODUCTION
// api. The origins are pinned in Metro's own environment (an exported variable
// outranks every env file), and the served bundle is checked before anything
// runs: it must name the local api and no deployed one.
//
// A SIMULATOR IS NOT A PHONE. The iOS simulator and an Apple-silicon emulator
// run at the Mac's speed and there is no CPU throttle for either. Every leg
// records the probe's calibration — fixed work timed on this device's Hermes —
// which is what makes readings from different devices comparable; for true phone
// numbers, run against a physical Android phone over USB (`adb reverse` reaches
// the local stack exactly as it does from the emulator).

export const EXPO_ROOT = join(E2E_ROOT, '..', 'apps', 'bracemark-expo');
export const APP_ID = 'com.bracemark.app';
export const METRO_URL = 'http://localhost:8081';
// mobile/flows/subflows/cold-launch.yaml's default, passed explicitly.
const DEV_CLIENT_LINK =
  'bracemark://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081%2F%3FdisableOnboarding%3D1';
const DEPLOYED_APIS = ['https://api.bracemark.com', 'https://api.dryrunbase.com'];
export const FLOWS = join(E2E_ROOT, 'measure', 'flows');

// Polling the Data card for a settled sync (see waitForSync below).
const SYNC_TIMEOUT_MS = 30 * 60 * 1000;
const SETTLED_POLLS = 3;

export interface DeviceOptions {
  platform: NativePlatform;
  deviceId: string;
}

export interface StallReading {
  label: string;
  wallMs: number;
  longestMs: number;
  blockingMs: number;
  stalls: number;
  // Absent from a bundle built before the probe counted frames.
  droppedFrames?: number;
}

export interface StallCalibration {
  iterations: number;
  workMs: number;
  probeMs: number;
}

export async function flow(
  name: string,
  options: DeviceOptions,
  env: Record<string, string> = {},
): Promise<void> {
  await maestro(join(FLOWS, name), {
    platform: options.platform,
    deviceId: options.deviceId,
    env: { EXPO_DEV_CLIENT_LINK: DEV_CLIENT_LINK, ...env },
  });
}

// The readout the flow stopped on, parsed — and the calibration held to the
// same bar as web's: nothing below is believed unless the probe saw the known
// stall (main-thread.ts, `calibrate`, for why that is not a formality).
export async function readProbe(
  options: DeviceOptions,
  label: string,
): Promise<{ reading: StallReading; calibration: StallCalibration }> {
  const root = parseHierarchy(await maestroHierarchy(options));
  const nodes = findNodes(
    root,
    (attributes) => attributes['resource-id'] === 'measure-stall-reading',
  );
  const texts = nodes
    .map((node) => node.attributes?.text || node.attributes?.accessibilityText)
    .filter((text): text is string => Boolean(text));
  if (texts.length === 0)
    throw new Error('no measure-stall-reading on screen — was the bundle built with the probe?');
  // More than one readout can be in the tree: Settings draws one, and the links
  // screen it covers keeps its own. Every one renders the same probe state, but a
  // covered screen may not re-render, so the readout with this leg's label wins;
  // with none, the first is what the error below reports.
  type Probe = { calibration?: StallCalibration; last?: StallReading };
  const parsed = texts.map((text) => ({ text, probe: JSON.parse(text) as Probe }));
  const { text, probe } = parsed.find((entry) => entry.probe.last?.label === label) ?? parsed[0];
  if (!probe.last || probe.last.label !== label) {
    throw new Error(`the reading on screen is not this ${label}'s: ${text}`);
  }
  const calibration = probe.calibration;
  if (!calibration)
    throw new Error('the probe has no calibration yet — it runs 1.5 s after launch');
  if (calibration.workMs < 50 || calibration.probeMs < calibration.workMs * 0.75) {
    throw new Error(
      `the probe missed its own calibration stall (work ${calibration.workMs} ms, ` +
        `seen ${calibration.probeMs} ms) — every reading would be a false low`,
    );
  }
  const dropped =
    probe.last.droppedFrames === undefined ? '' : `, ${probe.last.droppedFrames} dropped frames`;
  console.log(
    `  longest ${probe.last.longestMs} ms, blocking ${probe.last.blockingMs} ms, ` +
      `${probe.last.stalls} stalls${dropped} ` +
      `(calibration ${calibration.workMs} ms, seen ${calibration.probeMs} ms)`,
  );
  return { reading: probe.last, calibration };
}

// The Data card settled: nothing waiting and "Last synced", three polls in a row
// — seed/steps.ts `waitForSync`'s rule, for its reason (either half can read
// settled for a moment before the first live read lands).
export async function waitForSync(options: DeviceOptions): Promise<void> {
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let settled = 0;
  let lastReport = '';
  while (Date.now() < deadline) {
    const root = parseHierarchy(await maestroHierarchy(options));
    const texts = findNodes(root, () => true).map(
      (node) => `${node.attributes?.text ?? ''} ${node.attributes?.accessibilityText ?? ''}`,
    );
    const pending = texts.find((text) => /\d+ changes? waiting to sync/.test(text));
    const synced = texts.some((text) => /Last synced/.test(text));
    if (!pending && synced) {
      if (++settled >= SETTLED_POLLS) return;
    } else {
      settled = 0;
      const report = pending?.match(/\d+ changes? waiting to sync/)?.[0] ?? 'syncing';
      if (report !== lastReport) console.log(`  ${report}`);
      lastReport = report;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`the restore did not sync within ${SYNC_TIMEOUT_MS / 60_000} minutes`);
}

// --- Metro, serving the production bundle ---------------------------------------------

// `minify: false` keeps function names for a CPU profile (hermes-profile.ts) and
// costs nothing measurable (_finding what owns a native stall_, below).
export async function startMetro(
  platform: NativePlatform,
  runDir: string,
  { minify = true }: { minify?: boolean } = {},
): Promise<{ stop(): Promise<void> }> {
  await assertPortFree(METRO_URL, 'Metro (this run serves its own production bundle)');
  const log = createWriteStream(join(runDir, 'metro.log'));
  const child: ChildProcess = spawn(
    'npx',
    ['expo', 'start', '--no-dev', ...(minify ? ['--minify'] : []), '--port', '8081'],
    {
      cwd: EXPO_ROOT,
      // Its own process group, so stopping it takes Metro's workers too.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CI: '1',
        // See ⚠ above: these outrank .env.production, which --no-dev loads.
        // --no-dev is production mode, so metro.config.js's production guard
        // refuses a local URL without this.
        BRACEMARK_NONPROD_RELEASE: '1',
        EXPO_PUBLIC_API_URL: API_URL,
        EXPO_PUBLIC_SITE_URL: SITE_URL,
        EXPO_PUBLIC_MEASURE_STALLS: '1',
      },
    },
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const stop = async () => {
    if (child.pid !== undefined && child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    await new Promise<void>((resolve) => log.end(() => resolve()));
  };

  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        await fetch(`${METRO_URL}/status`);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('Metro did not start within 2 minutes');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    await assertMeasurementBundle(platform, minify);
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

// Fetch the bundle the device is about to load — which also warms Metro's cache
// for it — and refuse to run unless it is the build this run needs.
async function assertMeasurementBundle(platform: NativePlatform, minify: boolean): Promise<void> {
  const manifest = (await (
    await fetch(METRO_URL, {
      headers: { 'expo-platform': platform, accept: 'application/expo+json,application/json' },
    })
  ).json()) as { launchAsset?: { url?: string } };
  const url = manifest.launchAsset?.url;
  if (!url) throw new Error('Metro served no launch asset');
  if (!url.includes('dev=false') || url.includes('minify=true') !== minify) {
    throw new Error(`Metro is not serving a production bundle: ${url}`);
  }
  console.log('building the production bundle…');
  const bundle = await (await fetch(url)).text();
  const deployed = DEPLOYED_APIS.find((origin) => bundle.includes(origin));
  if (deployed) throw new Error(`the bundle names ${deployed} — refusing to run against it`);
  if (!bundle.includes(API_URL)) throw new Error(`the bundle does not name ${API_URL}`);
  if (!bundle.includes('measure-stall-reading')) {
    throw new Error('the bundle has no stall readout — EXPO_PUBLIC_MEASURE_STALLS did not apply');
  }
}

// --- the device ---------------------------------------------------------------------

export async function assertInstalled(options: DeviceOptions): Promise<void> {
  const installed =
    options.platform === 'ios'
      ? await capture('xcrun', ['simctl', 'get_app_container', options.deviceId, APP_ID], {
          allowFailure: true,
        })
      : await capture('adb', ['-s', options.deviceId, 'shell', 'pm', 'path', APP_ID], {
          allowFailure: true,
        });
  if (!installed.stdout.trim()) {
    throw new Error(
      `${APP_ID} is not installed on ${options.deviceId} — install a development build ` +
        '(`npm run expo:ios` / `npm run expo:android`) from this checkout first',
    );
  }
}

// The emulator (or a phone over USB) reaches the Mac's localhost through these —
// `npm run expo:android:reverse`'s three, idempotent.
export async function reversePorts(deviceId: string): Promise<void> {
  for (const port of ['8081', '8787', '8788']) {
    await capture('adb', ['-s', deviceId, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  }
}

export async function describeDevice(options: DeviceOptions): Promise<string> {
  if (options.platform === 'android') {
    const model = await capture('adb', [
      '-s',
      options.deviceId,
      'shell',
      'getprop',
      'ro.product.model',
    ]);
    const release = await capture('adb', [
      '-s',
      options.deviceId,
      'shell',
      'getprop',
      'ro.build.version.release',
    ]);
    return `${model.stdout.trim()}, Android ${release.stdout.trim()} (${options.deviceId})`;
  }
  const list = await capture('xcrun', ['simctl', 'list', 'devices']);
  const line = list.stdout.split('\n').find((entry) => entry.includes(options.deviceId));
  return `${line?.trim() ?? options.deviceId} (simulator)`;
}

export async function checkout(): Promise<{ commit: string; dirty: boolean }> {
  const [commit, status] = await Promise.all([
    capture('git', ['rev-parse', 'HEAD'], { cwd: join(E2E_ROOT, '..') }),
    capture('git', ['status', '--porcelain'], { cwd: join(E2E_ROOT, '..') }),
  ]);
  return { commit: commit.stdout.trim(), dirty: status.stdout.trim().length > 0 };
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

// A fixed-width table, the way every measure runner prints one.
export function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join('  ');
  console.log(`\n${line(header)}`);
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}
