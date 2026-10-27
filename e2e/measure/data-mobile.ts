import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MEASURE_OUTPUT } from '../paths';
import { type NativePlatform } from '../runner/cli';
import { deviceWidth, resolveDevice } from '../runner/device';
import { stageDocumentPickerFile } from '../runner/device-files';
import { createRunId, provisionAccount, writeJson } from '../runner/lib';
import { assertOriginOwnedByRepo } from '../runner/stack';
import { type E2EWidth } from '../runner/width';
import { API_URL, WEB_URL } from '../web/fixtures/env';
import { grantPlus } from '../web/fixtures/plan';
import { writeBackupLibrary, writeBookmarksHtml } from './library';
import { band } from './main-thread';
import { formatMemory, type MemoryReading, readMemory, traceMemory } from './memory';
import {
  APP_ID,
  assertInstalled,
  checkout,
  describeDevice,
  flow,
  printTable,
  readProbe,
  reversePorts,
  seconds,
  type StallCalibration,
  type StallReading,
  startMetro,
  waitForSync,
} from './native';

// How long import and export block bracemark-expo's JS thread, at library sizes
// you pick — the native half of docs/data-lifecycle.md, _main-thread cost_,
// beside measure/data-web.ts for web.
//
//   npm run dev                                   # api + web (accounts are made there)
//   npm run measure:data:ios                      # the one booted simulator
//   npm run measure:data:android -- --links 1000,10000
//   npm run measure:data:ios -- --device <udid>   # one of several booted
//   npm run measure:data:android -- --memory-trace  # + memory.jsonl, every 10 s
//
// NOT A TEST, for measure/data-web.ts's reason. Numbers for a person to read and
// record in the doc.
//
// THE INSTRUMENT, THE BUNDLE AND THE DEVICE are measure/native.ts's, shared
// with the render leg (measure/render-mobile.ts): the stall probe read off the
// screen, a production bundle on the development client with the api pinned,
// and a calibration on every leg because a simulator is not a phone.
//
// ON ANDROID IT ALSO READS MEMORY: `dumpsys meminfo` as each leg ends and around
// the restore's sync (measure/memory.ts), outside the probe's windows. The
// debug native shell makes these numbers higher than a release build's, so
// compare them run with run, not with a phone. Growth is the reading.

const EXPORT_FORMATS = [
  { format: 'netscape', label: 'HTML bookmarks' },
  { format: 'csv', label: 'CSV' },
  { format: 'text', label: 'Plain text' },
  { format: 'bracemark', label: 'Bracemark backup' },
] as const;

interface Options {
  platform: NativePlatform;
  deviceId: string;
  // The import flow's settings route turns on it (flows/import.yaml).
  width: E2EWidth;
  links: number[];
  exports: boolean;
  memoryTrace: boolean;
}

// What the command line says; `--device` is optional, as in the e2e runners.
type ParsedOptions = Omit<Options, 'deviceId' | 'width'> & { deviceId?: string };

interface NativeLeg {
  leg: string;
  reading: StallReading;
  calibration: StallCalibration;
  // The app's memory as the leg ends, outside the probe's window (measure/memory.ts).
  // Android only.
  memory?: MemoryReading;
}

// The restore's sync, which no probe windows: how long, and what it left behind.
interface SyncReading {
  links: number;
  wallMs: number;
  before?: MemoryReading;
  after?: MemoryReading;
}

function parseOptions(argv: string[]): ParsedOptions {
  let platform: NativePlatform | undefined;
  let deviceId: string | undefined;
  let links = [1_000, 10_000];
  let exports = true;
  let memoryTrace = false;
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
    else if (arg === '--memory-trace') memoryTrace = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!platform) {
    throw new Error(
      '--platform is required: ios or android. The root scripts carry it — ' +
        '`npm run measure:data:ios`, `measure:data:android`.',
    );
  }
  if (memoryTrace && platform !== 'android') {
    throw new Error('--memory-trace reads dumpsys, so it is Android only (measure/memory.ts)');
  }
  return { platform, deviceId, links, exports, memoryTrace };
}

async function main(): Promise<void> {
  const parsed = parseOptions(process.argv.slice(2));
  // Without `--device`, the one booted simulator or attached Android device
  // (runner/device.ts), and never a choice between two.
  const deviceId = await resolveDevice(parsed.platform, parsed.deviceId);
  const options: Options = {
    ...parsed,
    deviceId,
    width: await deviceWidth(parsed.platform, deviceId),
  };
  // The iPad's Files picker is a remote view: XCUITest sees none of it, so the
  // import flow could neither find the staged file nor tap it (flows/import.yaml).
  if (options.platform === 'ios' && options.width === 'wide') {
    throw new Error(
      'the data leg imports through the Files picker, which an iPad exposes nothing of to ' +
        'Maestro — run it on an iPhone simulator, or on the tablet AVD',
    );
  }
  await assertOriginOwnedByRepo(API_URL, 'bracemark-api', { required: true });
  await assertOriginOwnedByRepo(WEB_URL, 'bracemark-web', { required: true });
  await assertInstalled(options);
  if (options.platform === 'android') await reversePorts(options.deviceId);

  const runId = createRunId('measure-data-mobile');
  const runDir = join(MEASURE_OUTPUT, runId);
  await mkdir(runDir, { recursive: true });

  const metro = await startMetro(options.platform, runDir);
  const trace = options.memoryTrace
    ? traceMemory(options.deviceId, APP_ID, join(runDir, 'memory.jsonl'))
    : undefined;
  const legs: NativeLeg[] = [];
  const syncs: SyncReading[] = [];
  try {
    for (const links of options.links) {
      const size = await measureSize(links, runDir, options);
      legs.push(...size.legs);
      if (size.sync) syncs.push(size.sync);
    }
  } finally {
    await trace?.stop();
    await metro.stop();
  }

  const [device, tree] = await Promise.all([describeDevice(options), checkout()]);
  const resultsPath = await writeJson(join(runDir, 'results.json'), {
    runId,
    measuredAt: new Date().toISOString(),
    platform: options.platform,
    device,
    bundle: 'production (--no-dev --minify) on the development client',
    checkout: tree,
    legs,
    syncs,
  });
  report(legs, syncs);
  console.log(`\nresults: ${resultsPath}`);
}

async function measureSize(
  links: number,
  runDir: string,
  options: Options,
): Promise<{ legs: NativeLeg[]; sync?: SyncReading }> {
  const count = links.toLocaleString('en-US');
  // Names the document-picker staging accepts (runner/device-files.ts).
  const htmlName = `measure-bookmarks-${links}.html`;
  const backupName = `measure-backup-${links}.zip`;
  await writeBookmarksHtml(join(runDir, htmlName), links);
  await writeBackupLibrary(join(runDir, backupName), links);
  const legs: NativeLeg[] = [];
  let sync: SyncReading | undefined;

  // An empty library for the interop import, as on web.
  legs.push(await importLeg(`import HTML (${count})`, 'interop', htmlName, runDir, options));

  // The restore, then — in the same app session — the exports once it has synced.
  legs.push(await importLeg(`import backup (${count})`, 'restore', backupName, runDir, options));
  if (options.exports) {
    await flow('to-data.yaml', options);
    const before = await memoryOf(options);
    const started = Date.now();
    await waitForSync(options);
    sync = { links, wallMs: Date.now() - started, before, after: await memoryOf(options) };
    console.log(
      `  (the restore synced in ${seconds(sync.wallMs)} — not probed; native heap ` +
        `${formatMemory(sync.before)} → ${formatMemory(sync.after)})`,
    );
    for (const { label } of EXPORT_FORMATS) {
      const leg = `export ${label} (${count})`;
      console.log(`\n${leg}`);
      await flow('export.yaml', options, { FORMAT_LABEL: label });
      legs.push({ leg, ...(await readProbe(options, 'export')), memory: await memoryOf(options) });
      await flow('to-data.yaml', options);
    }
  }
  return { legs, sync };
}

function memoryOf(options: Options): Promise<MemoryReading | undefined> {
  return options.platform === 'android'
    ? readMemory(options.deviceId, APP_ID)
    : Promise.resolve(undefined);
}

async function importLeg(
  leg: string,
  account: string,
  fileName: string,
  runDir: string,
  options: Options,
): Promise<NativeLeg> {
  console.log(`\n${leg}`);
  const credentials = await provisionAccount(`measure-data-mobile-${account}`);
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
      E2E_WIDTH: options.width,
    });
  } finally {
    await unstage();
  }
  return { leg, ...(await readProbe(options, 'import')), memory: await memoryOf(options) };
}

// --- the report ---------------------------------------------------------------------

function report(legs: NativeLeg[], syncs: SyncReading[]): void {
  const rows = legs.map(({ leg, reading, calibration, memory }) => [
    leg,
    seconds(reading.wallMs),
    `${reading.longestMs.toLocaleString('en-US')} ms`,
    `${reading.blockingMs.toLocaleString('en-US')} ms`,
    String(reading.stalls),
    band(reading.longestMs),
    `${calibration.workMs} ms`,
    formatMemory(memory),
  ]);
  const header = [
    'leg',
    'wall',
    'longest stall',
    'blocking',
    'stalls',
    'band',
    'calibration',
    'native heap after',
  ];
  printTable(header, rows);
  for (const sync of syncs) {
    console.log(
      `\nthe ${sync.links.toLocaleString('en-US')}-link restore’s sync: ${seconds(sync.wallMs)}, ` +
        `native heap ${formatMemory(sync.before)} → ${formatMemory(sync.after)}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
