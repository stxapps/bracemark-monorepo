import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MEASURE_OUTPUT, profileDir } from '../paths';
import { type NativePlatform } from '../runner/cli';
import { deviceWidth, resolveDevice } from '../runner/device';
import { createRunId, writeJson } from '../runner/lib';
import { assertOriginOwnedByRepo } from '../runner/stack';
import { type E2EWidth } from '../runner/width';
import { API_URL, WEB_URL } from '../web/fixtures/env';
import { launchApp } from '../web/fixtures/launch';
import { grantPlusAndLoad } from '../web/fixtures/plan';
import { printSummary, startProfile } from './hermes-profile';
import {
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
import {
  assertLibraryLinks,
  type Leg,
  LEGS,
  type Library,
  parseLegs,
  parseLibrary,
  restoreLibrary as restoreOnWeb,
  SETTINGS_TARGETS,
} from './render-web';

// What scrolling the links list and docking/undocking its rail cost
// bracemark-expo's JS thread, per link layout, and what mounting the list and
// tag trees costs it — the render leg (docs/e2e.md, _the render leg_), beside
// measure/render-web.ts for web.
//
//   npm run dev                                     # api + web (the account is made there)
//   npm run measure:render:ios                      # the one booted simulator
//   npm run measure:render:android -- --layouts list --repeat 5
//   npm run measure:render:ios -- --library worst --legs sidebar,settings
//   npm run measure:render:ios -- --device <udid>   # one of several booted
//
// NOT A TEST, for measure/data-web.ts's reason: numbers for a person to read,
// compare before and after a change, and record.
//
// One fresh Plus account per run, restored ON WEB from a `plus-full`-shaped
// backup WITH its preview images (measure/library.ts) — the image slot is part
// of what a row costs to mount, so a library without them would under-read the
// list — then pulled by the device and left to come to rest before anything is
// measured: a sync still running writes `items` rows the whole time, and every
// live read on screen re-runs on them. Then per layout:
//
//   scroll    FLINGS flings down the list and as many back up, under the probe.
//             The headline is DROPPED FRAMES: a scroll's jank is a run of blocks
//             each under the 50 ms a stall needs (lib/stall-probe.ts), which the
//             stall count reads as a clean run.
//   rail      TOGGLES hide/show pairs of the docked links rail — wide windows
//             only (a tablet simulator or the tablet AVD); on a phone the rail
//             is a drawer and the leg is skipped. Each toggle changes the list
//             pane's width, which re-lays out every mounted item.
//
// and then once, whatever the layout, the two TREE legs — the surfaces that
// mount a row per list and per tag, unvirtualized (docs/client-queries.md,
// _the tree surfaces mount every row_):
//
//   sidebar   TOGGLES collapse/expand pairs of the links sidebar's Lists and
//             Tags sections (flows/render-sidebar.yaml). An expand mounts every
//             row the section holds: the cost the first load pays, made
//             repeatable. On a phone the window also holds the drawer opening
//             and closing around them.
//   settings  a switch from Settings → Misc to About (the baseline: a switch
//             with no table), to Lists and to Tags, each until its rows are in
//             (flows/render-settings.yaml).
//
// The tree legs want a big tree, which `plus-full`'s 24 lists and 40 tags are
// not: `--library worst` restores `plus-worst` instead (measure/library.ts).
//
// Each leg runs `--repeat` times and the report gives every run and the median:
// a single scroll reading moves with whatever the device was doing, and two
// runs that disagree are worth seeing as such.
//
// THE INSTRUMENT, THE BUNDLE AND THE DEVICE are measure/native.ts's, shared
// with the data path: the probe's window is opened and closed by measurement-
// only controls on the links screen (bracemark-expo components/measure-probe.tsx).

const LAYOUTS = { list: 'List', card: 'Card' } as const;
type Layout = keyof typeof LAYOUTS;

// After a layout pick, before the first window: the pick is a synced setting
// write, and the cycle it kicks re-runs every live read on screen.
const SETTLE_MS = 3000;

// Each library's first list and first tag, in rank order — the rows the sidebar
// flow waits on to know a section opened or closed. They are buildTree's first
// ids (seed/library.ts), under each library's prefix: the first root of a
// spec ranks first in its group, and a seeded root list ranks ahead of the
// system three.
const FIRST_ROWS: Record<Library, { list: string; tag: string }> = {
  full: { list: 'seed-list-00', tag: 'seed-tag-00' },
  worst: { list: 'worst-list-00', tag: 'worst-tag-00' },
};

interface Options {
  platform: NativePlatform;
  deviceId: string;
  library: Library;
  links: number;
  legs: Leg[];
  layouts: Layout[];
  flings: number;
  toggles: number;
  repeat: number;
  // A Hermes CPU profile around each tree-leg window, on an unminified bundle
  // (hermes-profile.ts). The sampler costs time of its own, so a profiled run's
  // readings are for attribution, not for the record.
  profile: boolean;
}

type ParsedOptions = Omit<Options, 'deviceId'> & { deviceId?: string };

interface RenderRun {
  // `settings <section>` on the settings leg, one per switch.
  leg: string;
  // null on the tree legs, which no layout touches.
  layout: Layout | null;
  run: number;
  reading: StallReading;
  calibration: StallCalibration;
}

function parseOptions(argv: string[]): ParsedOptions {
  let platform: NativePlatform | undefined;
  let deviceId: string | undefined;
  let library: Library = 'full';
  let links = 1_000;
  let linksGiven = false;
  let legs: Leg[] = [...LEGS];
  let layouts: Layout[] = ['list', 'card'];
  let flings = 8;
  let toggles = 5;
  let repeat = 3;
  let profile = false;
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
    if (arg === '--platform') {
      const next = value();
      if (next !== 'ios' && next !== 'android') throw new Error('--platform is ios or android');
      platform = next;
    } else if (arg === '--device') deviceId = value();
    else if (arg === '--library') library = parseLibrary(value());
    else if (arg === '--links') {
      links = count(arg, value());
      linksGiven = true;
    } else if (arg === '--legs') legs = parseLegs(value());
    else if (arg === '--layouts') {
      const names = value().split(',');
      const unknown = names.find((name) => !(name in LAYOUTS));
      if (unknown) throw new Error(`--layouts takes list and/or card, not ${unknown}`);
      layouts = names as Layout[];
    } else if (arg === '--flings') flings = count(arg, value());
    else if (arg === '--toggles') toggles = count(arg, value());
    else if (arg === '--repeat') repeat = count(arg, value());
    else if (arg === '--profile') profile = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!platform) {
    throw new Error(
      '--platform is required: ios or android. The root scripts carry it — ' +
        '`npm run measure:render:ios`, `measure:render:android`.',
    );
  }
  assertLibraryLinks(library, linksGiven);
  return { platform, deviceId, library, links, legs, layouts, flings, toggles, repeat, profile };
}

async function main(): Promise<void> {
  const parsed = parseOptions(process.argv.slice(2));
  const options: Options = {
    ...parsed,
    deviceId: await resolveDevice(parsed.platform, parsed.deviceId),
  };
  await assertOriginOwnedByRepo(API_URL, 'bracemark-api', { required: true });
  await assertOriginOwnedByRepo(WEB_URL, 'bracemark-web', { required: true });
  await assertInstalled(options);
  if (options.platform === 'android') await reversePorts(options.deviceId);
  const width = await deviceWidth(options.platform, options.deviceId);
  if (width !== 'wide') {
    console.log('a narrow window: the rail is a drawer here, so the rail leg is skipped');
  }

  const runId = createRunId('measure-render-mobile');
  const runDir = join(MEASURE_OUTPUT, runId);
  await mkdir(runDir, { recursive: true });

  const metro = await startMetro(options.platform, runDir, { minify: !options.profile });
  const runs: RenderRun[] = [];
  try {
    await restoreLibrary(runDir, width, options);
    if (options.legs.includes('scroll') || options.legs.includes('rail')) {
      for (const layout of options.layouts) {
        runs.push(...(await measureLayout(layout, width, options)));
      }
    }
    runs.push(...(await measureTrees(runDir, width, options)));
  } finally {
    await metro.stop();
  }

  const [device, tree] = await Promise.all([describeDevice(options), checkout()]);
  const resultsPath = await writeJson(join(runDir, 'results.json'), {
    runId,
    measuredAt: new Date().toISOString(),
    platform: options.platform,
    device,
    width,
    bundle: options.profile
      ? 'production (--no-dev, unminified) on the development client, PROFILED'
      : 'production (--no-dev --minify) on the development client',
    library: options.library,
    links: options.library === 'worst' ? null : options.links,
    flings: options.flings,
    toggles: options.toggles,
    checkout: tree,
    runs,
  });
  report(runs);
  console.log(`\nresults: ${resultsPath}`);
}

// The library goes in on WEB, and the device pulls it. The data leg imports on
// the device through the Files picker, but an iPad's picker is a remote view that
// exposes nothing to XCUITest (flows/import.yaml), and the rail leg needs a wide
// window; a web restore works on every device, and a pull is how a second device
// gets a library anyway. Then the device signs in, and the Data card is polled
// until the pull has landed.
async function restoreLibrary(runDir: string, width: E2EWidth, options: Options): Promise<void> {
  const app = await launchApp(profileDir('measure-render-mobile'));
  let credentials: { username: string; password: string };
  try {
    // Plus: free caps a library at 200 links (web/fixtures/plan.ts).
    await grantPlusAndLoad(app.page, app.credentials.username);
    await restoreOnWeb(app.page, runDir, options.library, options.links);
    credentials = app.credentials;
  } finally {
    await app.close();
  }
  console.log('signing the device in to pull it…');
  await flow('sign-in-settle.yaml', options, {
    USERNAME: credentials.username,
    PASSWORD: credentials.password,
    E2E_WIDTH: width,
  });
  const started = Date.now();
  await waitForSync(options);
  console.log(`  (pulled in ${seconds(Date.now() - started)} — not probed)`);
  await flow('close-settings.yaml', options);
}

async function measureLayout(
  layout: Layout,
  width: E2EWidth,
  options: Options,
): Promise<RenderRun[]> {
  await flow('render-layout.yaml', options, { LAYOUT: LAYOUTS[layout], E2E_WIDTH: width });
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const runs: RenderRun[] = [];
  for (let run = 1; run <= options.repeat && options.legs.includes('scroll'); run++) {
    console.log(`\nscroll, ${layout} layout, run ${run}/${options.repeat}`);
    await flow('render-scroll.yaml', options, { FLINGS: String(options.flings) });
    runs.push({ leg: 'scroll', layout, run, ...(await readProbe(options, 'scroll')) });
  }
  if (width !== 'wide') return runs;
  for (let run = 1; run <= options.repeat && options.legs.includes('rail'); run++) {
    console.log(`\nrail, ${layout} layout, run ${run}/${options.repeat}`);
    await flow('render-rail.yaml', options, { TOGGLES: String(options.toggles) });
    runs.push({ leg: 'rail', layout, run, ...(await readProbe(options, 'rail')) });
  }
  return runs;
}

// The tree legs, once each, after the layouts — no layout changes what they
// mount. Both start on the links screen and end there.
async function measureTrees(
  runDir: string,
  width: E2EWidth,
  options: Options,
): Promise<RenderRun[]> {
  const runs: RenderRun[] = [];
  // The flow, under a CPU profile when the run asks for one.
  const profiled = async (name: string, run: () => Promise<void>) => {
    if (!options.profile) return run();
    const session = await startProfile();
    await run();
    printSummary(name, await session.stop(join(runDir, `${name}.cpuprofile`)));
  };

  if (options.legs.includes('sidebar')) {
    const rows = FIRST_ROWS[options.library];
    for (let run = 1; run <= options.repeat; run++) {
      console.log(`\nsidebar, run ${run}/${options.repeat}`);
      await profiled(`sidebar-${run}`, () =>
        flow('render-sidebar.yaml', options, {
          TOGGLES: String(options.toggles),
          LIST_ROW: rows.list,
          TAG_ROW: rows.tag,
          E2E_WIDTH: width,
        }),
      );
      runs.push({ leg: 'sidebar', layout: null, run, ...(await readProbe(options, 'sidebar')) });
    }
  }

  if (options.legs.includes('settings')) {
    await flow('open-settings-misc.yaml', options, { E2E_WIDTH: width });
    // Misc's own reads, and the pause the links screen's reads took as Settings
    // covered it, out of the first window's way.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    for (const target of SETTINGS_TARGETS) {
      const leg = `settings ${target.section}`;
      for (let run = 1; run <= options.repeat; run++) {
        console.log(`\n${leg}, run ${run}/${options.repeat}`);
        await profiled(`settings-${target.section}-${run}`, () =>
          flow('render-settings.yaml', options, {
            SECTION: target.section,
            TITLE: target.title,
            ROW: target.row ?? 'none',
            E2E_WIDTH: width,
          }),
        );
        const label = `settings-${target.section}`;
        runs.push({ leg, layout: null, run, ...(await readProbe(options, label)) });
      }
    }
    await flow('close-settings.yaml', options);
  }

  return runs;
}

// --- the report ---------------------------------------------------------------------

function report(runs: RenderRun[]): void {
  const rows = runs.map(({ leg, layout, run, reading }) => [
    leg,
    layout ?? '—',
    String(run),
    String(reading.droppedFrames ?? '—'),
    `${reading.longestMs.toLocaleString('en-US')} ms`,
    `${reading.blockingMs.toLocaleString('en-US')} ms`,
    String(reading.stalls),
    seconds(reading.wallMs),
  ]);
  printTable(
    ['leg', 'layout', 'run', 'dropped frames', 'longest', 'blocking', 'stalls', 'wall'],
    rows,
  );

  // The median per leg and layout — the number to compare across a change.
  const groups = new Map<string, RenderRun[]>();
  for (const run of runs) {
    const key = run.layout ? `${run.leg} ${run.layout}` : run.leg;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  printTable(
    ['median', 'dropped frames', 'longest', 'blocking'],
    [...groups].map(([key, group]) => [
      key,
      String(median(group.map((run) => run.reading.droppedFrames ?? 0))),
      `${median(group.map((run) => run.reading.longestMs))} ms`,
      `${median(group.map((run) => run.reading.blockingMs))} ms`,
    ]),
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
