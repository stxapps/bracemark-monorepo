import { type ChildProcess, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { E2E_ROOT, MEASURE_OUTPUT } from '../paths';
import { type NativePlatform } from '../runner/cli';
import { stageDocumentPickerFile } from '../runner/device-files';
import { findNodes, parseHierarchy } from '../runner/hierarchy';
import { createRunId, maestro, maestroHierarchy, provisionAccount, writeJson } from '../runner/lib';
import { capture } from '../runner/process';
import { assertOriginOwnedByRepo, assertPortFree } from '../runner/stack';
import { API_URL, SITE_URL, WEB_URL } from '../web/fixtures/env';
import { grantPlus } from '../web/fixtures/plan';
import { writeBackupLibrary, writeBookmarksHtml } from './library';
import { band } from './main-thread';

// How long import and export block bracemark-expo's JS thread, at library sizes
// you pick — the native half of docs/data-lifecycle.md, _main-thread cost_,
// beside measure/data.ts for web.
//
//   npm run dev                                   # api + web (accounts are made there)
//   npm run measure:native -- --platform ios --device <udid>
//   npm run measure:native -- --platform android --device <serial> --links 1000,10000
//
// NOT A TEST, for measure/data.ts's reason. Numbers for a person to read and
// record in the doc.
//
// THE INSTRUMENT is expo-react's stall probe (lib/stall-probe.ts): a 16 ms timer
// whose lateness is the JS thread's blocking, windowed by the import and export
// hooks, and rendered by the Data view as `measure-stall-reading` text that this
// runner reads off the accessibility tree. It is compiled in only when the
// bundle is built with EXPO_PUBLIC_MEASURE_STALLS=1, which this runner sets.
//
// A PRODUCTION BUNDLE ON THE DEVELOPMENT CLIENT, and why not a release build. A
// release build bakes its api origin, and against localhost it is unsupported
// (docs/env-files.md, _bracemark-expo_: Android refuses cleartext) — the only
// release build that could run this is a staging one, which would push tens of
// thousands of links into a deployed tier. So the installed dev client loads a
// bundle Metro serves with `--no-dev --minify`: __DEV__ off, React's production
// build, Hermes, minified — the JS a release build runs. Only the native shell is
// the debug one, and the probe measures JS.
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
// numbers, run this against a physical Android phone over USB (`adb reverse`
// reaches the local stack exactly as it does from the emulator).

const EXPO_ROOT = join(E2E_ROOT, '..', 'apps', 'bracemark-expo');
const APP_ID = 'com.bracemark.app';
const METRO_URL = 'http://localhost:8081';
// mobile/flows/subflows/cold-launch.yaml's default, passed explicitly.
const DEV_CLIENT_LINK =
  'bracemark://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081%2F%3FdisableOnboarding%3D1';
const DEPLOYED_APIS = ['https://api.bracemark.com', 'https://api.dryrunbase.com'];
const FLOWS = join(E2E_ROOT, 'measure', 'flows');

// Polling the Data card for a settled sync (see waitForSync below).
const SYNC_TIMEOUT_MS = 30 * 60 * 1000;
const SETTLED_POLLS = 3;

const EXPORT_FORMATS = [
  { format: 'netscape', label: 'HTML bookmarks' },
  { format: 'csv', label: 'CSV' },
  { format: 'text', label: 'Plain text' },
  { format: 'bracemark', label: 'Bracemark backup' },
] as const;

interface Options {
  platform: NativePlatform;
  deviceId: string;
  links: number[];
  exports: boolean;
}

interface StallReading {
  label: string;
  wallMs: number;
  longestMs: number;
  blockingMs: number;
  stalls: number;
}

interface StallCalibration {
  iterations: number;
  workMs: number;
  probeMs: number;
}

interface NativeLeg {
  leg: string;
  reading: StallReading;
  calibration: StallCalibration;
}

function parseOptions(argv: string[]): Options {
  let platform: NativePlatform | undefined;
  let deviceId: string | undefined;
  let links = [1_000, 10_000];
  let exports = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === '--platform') {
      const next = value();
      if (next !== 'ios' && next !== 'android') throw new Error('--platform is ios or android');
      platform = next;
    } else if (arg === '--device') deviceId = value();
    else if (arg === '--links') {
      links = value()
        .split(',')
        .map((part) => Number(part.replaceAll('_', '')));
      if (links.some((n) => !Number.isInteger(n) || n < 1)) {
        throw new Error('--links takes positive whole numbers, comma-separated');
      }
    } else if (arg === '--no-exports') exports = false;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!platform || !deviceId) {
    throw new Error(
      '--platform and --device are required (`xcrun simctl list devices booted` or `adb devices`)',
    );
  }
  return { platform, deviceId, links, exports };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await assertOriginOwnedByRepo(API_URL, 'bracemark-api', { required: true });
  await assertOriginOwnedByRepo(WEB_URL, 'bracemark-web', { required: true });
  await assertInstalled(options);
  if (options.platform === 'android') await reversePorts(options.deviceId);

  const runId = createRunId('measure-native');
  const runDir = join(MEASURE_OUTPUT, runId);
  await mkdir(runDir, { recursive: true });

  const metro = await startMetro(options.platform, runDir);
  const legs: NativeLeg[] = [];
  try {
    for (const links of options.links) {
      legs.push(...(await measureSize(links, runDir, options)));
    }
  } finally {
    await metro.stop();
  }

  const [device, commit, status] = await Promise.all([
    describeDevice(options),
    capture('git', ['rev-parse', 'HEAD'], { cwd: join(E2E_ROOT, '..') }),
    capture('git', ['status', '--porcelain'], { cwd: join(E2E_ROOT, '..') }),
  ]);
  const resultsPath = await writeJson(join(runDir, 'results.json'), {
    runId,
    measuredAt: new Date().toISOString(),
    platform: options.platform,
    device,
    bundle: 'production (--no-dev --minify) on the development client',
    checkout: { commit: commit.stdout.trim(), dirty: status.stdout.trim().length > 0 },
    legs,
  });
  report(legs);
  console.log(`\nresults: ${resultsPath}`);
}

async function measureSize(links: number, runDir: string, options: Options): Promise<NativeLeg[]> {
  const count = links.toLocaleString('en-US');
  // Names the document-picker staging accepts (runner/device-files.ts).
  const htmlName = `measure-bookmarks-${links}.html`;
  const backupName = `measure-backup-${links}.zip`;
  await writeBookmarksHtml(join(runDir, htmlName), links);
  await writeBackupLibrary(join(runDir, backupName), links);
  const legs: NativeLeg[] = [];

  // An empty library for the interop import, as on web.
  legs.push(await importLeg(`import HTML (${count})`, 'interop', htmlName, runDir, options));

  // The restore, then — in the same app session — the exports once it has synced.
  legs.push(await importLeg(`import backup (${count})`, 'restore', backupName, runDir, options));
  if (options.exports) {
    await flow('to-data.yaml', options);
    const started = Date.now();
    await waitForSync(options);
    console.log(`  (the restore synced in ${seconds(Date.now() - started)} — not measured)`);
    for (const { label } of EXPORT_FORMATS) {
      const leg = `export ${label} (${count})`;
      console.log(`\n${leg}`);
      await flow('export.yaml', options, { FORMAT_LABEL: label });
      legs.push({ leg, ...(await readProbe(options, 'export')) });
      await flow('to-data.yaml', options);
    }
  }
  return legs;
}

async function importLeg(
  leg: string,
  account: string,
  fileName: string,
  runDir: string,
  options: Options,
): Promise<NativeLeg> {
  console.log(`\n${leg}`);
  const credentials = await provisionAccount(`measure-native-${account}`);
  // Plus: free caps a library at 200 links. Granted before the device signs in,
  // so its first entitlement read already carries it (web/fixtures/plan.ts).
  await grantPlus(credentials.username);
  const unstage = await stageDocumentPickerFile({
    platform: options.platform,
    deviceId: options.deviceId,
    sourcePath: join(runDir, fileName),
    fileName,
  });
  try {
    await flow('import.yaml', options, {
      USERNAME: credentials.username,
      PASSWORD: credentials.password,
      IMPORT_FILE_STEM: fileName.replace(/\.[^.]+$/, ''),
    });
  } finally {
    await unstage();
  }
  return { leg, ...(await readProbe(options, 'import')) };
}

async function flow(
  name: string,
  options: Options,
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
async function readProbe(
  options: Options,
  label: string,
): Promise<{ reading: StallReading; calibration: StallCalibration }> {
  const root = parseHierarchy(await maestroHierarchy(options));
  const nodes = findNodes(
    root,
    (attributes) => attributes['resource-id'] === 'measure-stall-reading',
  );
  const text = nodes.map((node) => node.attributes?.text || node.attributes?.accessibilityText)[0];
  if (!text)
    throw new Error('no measure-stall-reading on screen — was the bundle built with the probe?');
  const probe = JSON.parse(text) as { calibration?: StallCalibration; last?: StallReading };
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
  console.log(
    `  longest ${probe.last.longestMs} ms, blocking ${probe.last.blockingMs} ms, ` +
      `${probe.last.stalls} stalls (calibration ${calibration.workMs} ms, seen ${calibration.probeMs} ms)`,
  );
  return { reading: probe.last, calibration };
}

// The Data card settled: nothing waiting and "Last synced", three polls in a row
// — seed/steps.ts `waitForSync`'s rule, for its reason (either half can read
// settled for a moment before the first live read lands).
async function waitForSync(options: Options): Promise<void> {
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

async function startMetro(
  platform: NativePlatform,
  runDir: string,
): Promise<{ stop(): Promise<void> }> {
  await assertPortFree(METRO_URL, 'Metro (this run serves its own production bundle)');
  const log = createWriteStream(join(runDir, 'metro.log'));
  const child: ChildProcess = spawn(
    'npx',
    ['expo', 'start', '--no-dev', '--minify', '--port', '8081'],
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
    await assertMeasurementBundle(platform);
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

// Fetch the bundle the device is about to load — which also warms Metro's cache
// for it — and refuse to run unless it is the build this run needs.
async function assertMeasurementBundle(platform: NativePlatform): Promise<void> {
  const manifest = (await (
    await fetch(METRO_URL, {
      headers: { 'expo-platform': platform, accept: 'application/expo+json,application/json' },
    })
  ).json()) as { launchAsset?: { url?: string } };
  const url = manifest.launchAsset?.url;
  if (!url) throw new Error('Metro served no launch asset');
  if (!url.includes('dev=false') || !url.includes('minify=true')) {
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

async function assertInstalled(options: Options): Promise<void> {
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
async function reversePorts(deviceId: string): Promise<void> {
  for (const port of ['8081', '8787', '8788']) {
    await capture('adb', ['-s', deviceId, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  }
}

async function describeDevice(options: Options): Promise<string> {
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

// --- the report ---------------------------------------------------------------------

function report(legs: NativeLeg[]): void {
  const rows = legs.map(({ leg, reading, calibration }) => [
    leg,
    seconds(reading.wallMs),
    `${reading.longestMs.toLocaleString('en-US')} ms`,
    `${reading.blockingMs.toLocaleString('en-US')} ms`,
    String(reading.stalls),
    band(reading.longestMs),
    `${calibration.workMs} ms`,
  ]);
  const header = ['leg', 'wall', 'longest stall', 'blocking', 'stalls', 'band', 'calibration'];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join('  ');
  console.log(`\n${line(header)}`);
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
