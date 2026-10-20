import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type BrowserContext, expect, type Page } from '@playwright/test';

import {
  ALL_ID,
  formatSyncTraceSummary,
  summarizeSyncTrace,
  type SyncSpan,
  TRASH_ID,
} from '@stxapps/shared';

import { E2E_ROOT, MEASURE_OUTPUT, profileDir } from '../paths';
import { E2E_ORIGINS, IS_STAGING } from '../runner/environment';
import { createRunId, waitForApi, writeJson } from '../runner/lib';
import { capture } from '../runner/process';
import { assertOriginOwnedByRepo } from '../runner/stack';
import { STAGING_PLAN_GRANTS } from '../runner/staging-credential';
import { proveStagingPlanAccess } from '../seed/d1';
import { type Credentials } from '../web/fixtures/account';
import { CHROME_PATH } from '../web/fixtures/env';
import { launchApp, type LaunchedApp } from '../web/fixtures/launch';
import { grantPlusAndLoad } from '../web/fixtures/plan';
import { writeBackupLibrary, writeBookmarksHtml } from './library';
import { instrument } from './main-thread';
import { captureNetwork, type NetRequest, type NetworkCapture } from './network';
import {
  cyclesOf,
  formatNetwork,
  formatServerTiming,
  highlights,
  summarizeNetwork,
  waterfall,
} from './sync-report';

// Where a bracemark-web sync spends its time — the measurement behind
// docs/local-first-sync.md, _measuring a sync_. A push of 1,000 links took
// minutes on both clients, and a stopwatch can only confirm that; this breaks
// the time down by phase, by request and by server call, so the fix goes where
// the time actually is.
//
//   npm run measure:sync:staging                      # dryrunbase.com — the reading that counts
//   npm run measure:sync:staging -- --links 1000,5000
//   npm run measure:sync:staging -- --no-sw           # the service worker blocked
//   npm run measure:sync:staging -- --legs push       # just the push
//   npm run measure:sync:staging -- --links 10000 --legs bulk-edit --bulk 100,500
//   npm run measure:sync                              # the local stack (`npm run dev`)
//
// THREE INSTRUMENTS, read together per leg:
//
//   the engine's spans   @stxapps/shared sync/trace.ts, switched on by a
//                        localStorage flag this runner sets before the app loads
//                        (web-react sync/trace.ts). Phases, per-blob timings, and
//                        how many transfers were really in flight.
//   the network          Chrome's Network domain over CDP (network.ts): queueing,
//                        protocol, sockets, time to first byte, preflights.
//   the api's account    bracemark-api's Server-Timing (lib/server-timing.ts),
//                        read off those same responses: the session read, the
//                        Durable Object, R2's HEADs, presigning.
//
// Plus the main-thread instrument data.ts uses, because a sync whose callbacks
// queue behind a busy main thread is slow for a reason no network reading shows.
//
// STAGING IS THE TARGET. Locally, blob bytes go through the api (bracemark-api
// r2/local.ts) — the presigned R2 transfer, its CORS and its protocol, which are
// the prime suspects, don't happen at all — and the web app is the dev server,
// which registers no service worker. A local reading is for a client-side
// question (IndexedDB, re-renders), and the report says which one it is.
//
// ⚠ STAGING MUST RUN THIS CHECKOUT. The spans and the Server-Timing header ship
// in the deployed app and api; an older deploy has neither, and the run stops
// at the first leg rather than report a breakdown of nothing. Deploy both
// first (docs/hosting.md).
//
// NOT A TEST, in no suite, for the reason data.ts gives: timing over the public
// internet is noisy. Run a size more than once before believing a difference.
//
// THE LEGS, per size:
//
//   push         a fresh Plus account restores a backup of `seed_plus_full`'s
//                shape (seed/library.ts, scaled to --links, preview images
//                included unless --no-images) and the runner waits for the
//                queue to drain. The window opens at the file pick: an import
//                kicks cycles while it is still writing, so the push starts
//                before the receipt does. The import/sync split is reported.
//   pull         a second fresh browser signs in to that account; the first
//                sync is the `initial` cycle.
//   incremental  the first browser imports 100 more links (an HTML file) and
//                pushes them; the second opens a page, whose opening cycle
//                pulls them.
//   floor        in the second browser, the GET URLs the pull minted are
//                fetched again directly, at several concurrencies, with no
//                engine around them: the fastest this browser can move these
//                blobs from R2. The engine's own GET rate beside it is its
//                overhead.
//   bulk-edit    per --bulk size (10, 100 and 1,000 by default), the first
//                browser selects that many links in the all-links view and
//                adds a new tag to them through Bulk edit → Edit tags — one
//                `links/` put each — and the leg is read twice: the editing
//                browser's push, then the second browser's pull of it.
//   bulk-delete  the first browser moves --delete links (100) to Trash,
//                unmeasured, then deletes them permanently from the Trash
//                view: deletes ride the commit alone, no upload, and the
//                commit removes the objects. Read on both browsers again.
//
// The floor is GET-only on purpose. A PUT floor would have to write over the
// account's objects with bytes the app did not produce.
//
// THE LIBRARY'S IDS ARE SCATTERED (library.ts, `scatterIds`), as an app-minted
// library's are. The bulk legs are where it shows: the commit's existence check
// pages through R2's key order, so N edits among L links cost about L / 1,000
// listing pages when they are spread out and one when they are adjacent. A
// bulk edit is cheap at the default 1,000 links either way; the sparse case —
// the one a large library's owner meets — needs --links 10000 or more.

const LEG_TIMEOUT_MS = 60 * 60 * 1000;
// web-react sync/trace.ts, SYNC_TRACE_FLAG — duplicated: e2e reads the app from
// outside, and a renamed flag should fail the "no trace" guard, loudly.
const TRACE_FLAG = 'bracemark.syncTrace';
// The settled reading: no pending op and no new span for this long.
const QUIET_MS = 2000;
// A queue that hasn't moved for this long, with nothing running, gets the Data
// card's one action — "Sync now" when the last cycle was clean, "Retry" when it
// failed — and the press is reported, because the engine should need neither. A
// failed background cycle schedules no retry of its own (web-react
// sync-provider.tsx, the error branch), so without the "Retry" press one R2
// timeout leaves the queue where it stopped for the rest of the run.
const STUCK_MS = 60_000;
const FLOOR_LEVELS = [6, 12, 24, 48];
const FLOOR_SAMPLE = 480;
const INCREMENTAL_LINKS = 100;
const BULK_SIZES = [10, 100, 1000];
const BULK_DELETE_SIZE = 100;
// Every link outside Trash, oldest-added last: `sort`/`order` are the read-only
// URL override of the synced sort (docs/search.md), so an edit — which moves a
// link's date MODIFIED — never reorders the rows the next size selects.
const ALL_LINKS_VIEW = `/links?list=${ALL_ID}&sort=createdAt&order=desc`;
const TRASH_VIEW = `/links?list=${TRASH_ID}&sort=createdAt&order=desc`;
// useLinks' page (bracemark-web links/_hooks/use-links.ts, PAGE_SIZE): Select
// all takes the loaded rows, and "Show more" loads this many more.
const LINKS_PAGE = 50;
const LEGS = ['push', 'pull', 'incremental', 'floor', 'bulk-edit', 'bulk-delete'] as const;
type Leg = (typeof LEGS)[number];

interface Options {
  links: number[];
  legs: Set<Leg>;
  bulk: number[];
  deleteSize: number;
  images: boolean;
  serviceWorkers: 'allow' | 'block';
  cpuRate: number;
  headed: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    links: [1000],
    legs: new Set(LEGS),
    bulk: BULK_SIZES,
    deleteSize: BULK_DELETE_SIZE,
    images: true,
    serviceWorkers: 'allow',
    cpuRate: 1,
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
    } else if (arg === '--legs') {
      const legs = value().split(',');
      const unknown = legs.filter((leg) => !(LEGS as readonly string[]).includes(leg));
      if (unknown.length > 0) throw new Error(`unknown leg(s) ${unknown.join(', ')}`);
      options.legs = new Set(legs as Leg[]);
    } else if (arg === '--bulk') {
      options.bulk = value()
        .split(',')
        .map((part) => Number(part.replaceAll('_', '')));
      if (options.bulk.some((n) => !Number.isInteger(n) || n < 1)) {
        throw new Error('--bulk takes positive whole numbers, comma-separated');
      }
    } else if (arg === '--delete') {
      options.deleteSize = Number(value().replaceAll('_', ''));
      if (!Number.isInteger(options.deleteSize) || options.deleteSize < 1) {
        throw new Error('--delete takes a positive whole number');
      }
    } else if (arg === '--no-images') options.images = false;
    else if (arg === '--no-sw') options.serviceWorkers = 'block';
    else if (arg === '--cpu') {
      options.cpuRate = Number(value());
      if (!(options.cpuRate >= 1)) throw new Error('--cpu takes a slowdown factor of 1 or more');
    } else if (arg === '--headed') options.headed = true;
    else throw new Error(`unknown option ${arg}`);
  }
  // Every later leg reads the library the push wrote, and the floor reuses the
  // pull's URLs.
  options.legs.add('push');
  if (options.legs.has('floor')) options.legs.add('pull');
  return options;
}

interface LegResult {
  leg: string;
  links: number;
  // The links a bulk leg actually changed — Select all takes whole pages, so it
  // can overshoot the size asked for, and a small library can fall short of it.
  edited?: number;
  wallMs: number;
  window: { since: number; until: number };
  // Whether the app's service worker answered this page's requests.
  serviceWorker: boolean;
  phases: ReturnType<typeof summarizeSyncTrace>;
  cycles: ReturnType<typeof cyclesOf>;
  network: ReturnType<typeof summarizeNetwork>;
  mainThread: { longestTaskMs: number; blockingMs: number; longTasks: number };
  highlights: string[];
  notes: string[];
  floor?: FloorReading[];
  files: { spans: string; network: string; waterfall: string };
}

interface FloorReading {
  concurrency: number;
  n: number;
  wallMs: number;
  p50Ms: number;
  p95Ms: number;
  perSecond: number;
  failed: number;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const appOrigin = E2E_ORIGINS.web;

  if (IS_STAGING) {
    // The plan grant is the one write this run makes outside the app, and the
    // staging door for it is narrow (seed/d1.ts, planD1): prove the credential
    // before an account exists, then open it for this process alone.
    const from = await proveStagingPlanAccess();
    process.env[STAGING_PLAN_GRANTS] = '1';
    console.log(`staging plan grants: credential from ${from}`);
  } else {
    await waitForApi();
    await assertOriginOwnedByRepo(E2E_ORIGINS.api, 'bracemark-api', { required: true });
    await assertOriginOwnedByRepo(appOrigin, 'bracemark-web', { required: true });
  }

  const runId = createRunId('measure-sync');
  const runDir = join(MEASURE_OUTPUT, runId);
  await mkdir(runDir, { recursive: true });
  const target = IS_STAGING ? `staging (${appOrigin})` : `local stack (${appOrigin}) — not R2`;
  console.log(
    `measuring sync on ${target}, service worker ${options.serviceWorkers === 'block' ? 'blocked' : 'allowed'}, ` +
      `CPU ${options.cpuRate}x, into ${runDir}`,
  );

  const results: LegResult[] = [];
  for (const links of options.links) {
    results.push(...(await measureSize(links, runDir, appOrigin, options)));
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
    options: { ...options, legs: [...options.legs] },
    browser: chrome.stdout.trim() || 'unknown',
    checkout: { commit: commit.stdout.trim(), dirty: status.stdout.trim().length > 0 },
    results,
  });
  console.log(`\nresults: ${resultsPath}`);
  console.log('waterfalls open in https://ui.perfetto.dev (or chrome://tracing)');
}

async function measureSize(
  links: number,
  runDir: string,
  appOrigin: string,
  options: Options,
): Promise<LegResult[]> {
  const backup = join(runDir, `backup-${links}.zip`);
  await writeBackupLibrary(backup, links, { images: options.images, scatterIds: true });
  const results: LegResult[] = [];

  const a = await openDevice(`measure-sync-a-${links}`, options);
  let b: Device | undefined;
  // The second browser for a leg that only reads it later. Signing in starts its
  // first sync — the whole library — in the background, so it is run to the end
  // here, unmeasured: left running, it shared the network with the next leg's
  // writes and held the leg's own queue behind ~23,000 downloads at 10,000 links.
  const second = async (): Promise<Device> => {
    if (!b) {
      const opened = await openDevice(`measure-sync-b-${links}`, options, a.app.credentials);
      b = opened;
      await settleFirstSync(opened);
    }
    return b;
  };
  try {
    await grantPlusAndLoad(a.app.page, a.app.credentials.username);
    results.push(await pushLeg(a, backup, links, runDir, appOrigin, options));

    if (options.legs.has('pull')) {
      b = await openDevice(`measure-sync-b-${links}`, options, a.app.credentials);
      const pull = await pullLeg(b, links, runDir, appOrigin, options);
      results.push(pull);
      if (options.legs.has('floor')) {
        results.push(await floorLeg(b, links, runDir, appOrigin, pull));
      }
    }

    if (options.legs.has('incremental')) {
      const html = join(runDir, `bookmarks-${INCREMENTAL_LINKS}.html`);
      await writeBookmarksHtml(html, INCREMENTAL_LINKS);
      results.push(
        await incrementalLeg(a, await second(), html, links, runDir, appOrigin, options),
      );
    }

    if (options.legs.has('bulk-edit')) {
      const other = await second();
      for (const size of options.bulk) {
        results.push(...(await bulkEditLeg(a, other, size, links, runDir, appOrigin, options)));
      }
    }

    // Last: it removes links every leg before it reads.
    if (options.legs.has('bulk-delete')) {
      const other = await second();
      results.push(
        ...(await bulkDeleteLeg(a, other, options.deleteSize, links, runDir, appOrigin, options)),
      );
    }
  } finally {
    await b?.close();
    await a.close();
  }
  return results;
}

// --- the devices -------------------------------------------------------------------

interface Device {
  app: LaunchedApp;
  net: NetworkCapture;
  close(): Promise<void>;
}

// A signed-in browser with the trace flag, the main-thread instrument and the
// network capture all in place BEFORE the account ceremony — so a second
// device's first sync, which starts inside the sign-in, is captured whole.
async function openDevice(name: string, options: Options, existing?: Credentials): Promise<Device> {
  let net: NetworkCapture | undefined;
  const app = await launchApp(profileDir(name), {
    headed: options.headed,
    serviceWorkers: options.serviceWorkers,
    ...(existing ? { existing } : {}),
    prepare: async (context: BrowserContext) => {
      await context.addInitScript(
        `try { localStorage.setItem(${JSON.stringify(TRACE_FLAG)}, '1'); } catch {}`,
      );
      await instrument(context);
      const page = context.pages()[0] ?? (await context.newPage());
      net = await captureNetwork(page);
    },
  });
  if (!net) throw new Error('the network capture did not start');
  const network = net;
  return {
    app,
    net: network,
    async close() {
      await network.stop();
      await app.close();
    },
  };
}

// --- the legs ----------------------------------------------------------------------

async function pushLeg(
  a: Device,
  backup: string,
  links: number,
  runDir: string,
  appOrigin: string,
  options: Options,
): Promise<LegResult> {
  const leg = `push (${links.toLocaleString('en-US')} links)`;
  console.log(`\n${leg}`);
  const { page } = a.app;
  await page.goto('/settings/data');
  await assertTraced(page);
  await page.getByRole('button', { name: /^Import data/ }).click();
  const receipt = page.getByText(/^Imported \d+ link/);
  const failure = page.getByText(/^Import failed:/);

  await clearTrace(page);
  const throttle = await throttleCpu(page, options.cpuRate);
  const since = Date.now();
  let imported: number;
  let drain: Drain;
  try {
    await page.locator('input[type=file]').setInputFiles(backup);
    await expect(receipt.or(failure)).toBeVisible({ timeout: LEG_TIMEOUT_MS });
    if (await failure.isVisible()) throw new Error(await failure.innerText());
    imported = Date.now();
    console.log(`  ${(await receipt.innerText()).trim()} after ${seconds(imported - since)}`);
    await backToDataOverview(page);
    drain = await waitForDrain(page);
  } finally {
    await throttle.release();
  }

  const result = await readLeg(a, page, leg, links, since, runDir, appOrigin);
  result.notes.push(
    `import (file pick → receipt) ${seconds(imported - since)}; ` +
      `sync after the receipt ${seconds(result.window.until - imported)}`,
  );
  result.notes.push(...drainNotes(drain));
  report(result);
  return result;
}

async function pullLeg(
  b: Device,
  links: number,
  runDir: string,
  appOrigin: string,
  options: Options,
): Promise<LegResult> {
  const leg = `pull (${links.toLocaleString('en-US')} links)`;
  console.log(`\n${leg}`);
  const { page } = b.app;
  // The first sync already ran inside the sign-in; its `initial` cycle is the leg.
  await assertTraced(page);
  const initial = await waitForSpan(page, (s) => s.name === 'cycle' && s.attrs?.kind === 'initial');
  if (options.cpuRate > 1) {
    console.log('  (the pull ran inside the sign-in, before --cpu could apply: it is at 1x)');
  }
  const drain = await waitForDrain(page);
  const result = await readLeg(b, page, leg, links, initial.start, runDir, appOrigin, initial.end);
  // A failed first sync still ends the span, so the leg would otherwise read as
  // a pull that finished — of a fraction of the library.
  if (initial.failed) {
    result.notes.push(`the initial sync FAILED (${initial.failed}): this is a partial pull`);
  }
  result.notes.push(...drainNotes(drain));
  report(result);
  return result;
}

// The second browser's first sync, waited out unmeasured (measureSize, `second`):
// the `initial` cycle, then the cycle the provider kicks after it.
async function settleFirstSync(b: Device): Promise<void> {
  const { page } = b.app;
  await assertTraced(page);
  const since = Date.now();
  const initial = await waitForSpan(page, (s) => s.name === 'cycle' && s.attrs?.kind === 'initial');
  if (initial.failed) throw new Error(`the second browser’s first sync failed: ${initial.failed}`);
  await waitForDrain(page, initial.start);
  console.log(`  (the second browser’s first sync, unmeasured: ${seconds(Date.now() - since)})`);
}

async function incrementalLeg(
  a: Device,
  b: Device,
  html: string,
  links: number,
  runDir: string,
  appOrigin: string,
  options: Options,
): Promise<LegResult> {
  const leg = `incremental (${INCREMENTAL_LINKS} links onto ${links.toLocaleString('en-US')})`;
  console.log(`\n${leg}`);

  // Device A writes and pushes them — unmeasured.
  await a.app.page.goto('/settings/data');
  await a.app.page.getByRole('button', { name: /^Import data/ }).click();
  await a.app.page.locator('input[type=file]').setInputFiles(html);
  await expect(a.app.page.getByText(/^Imported \d+ link/)).toBeVisible({
    timeout: LEG_TIMEOUT_MS,
  });
  await backToDataOverview(a.app.page);
  const pushed = await waitForDrain(a.app.page);

  const result = await pullOnOpen(b, leg, links, runDir, appOrigin, options);
  result.notes.push(...drainNotes(pushed).map((note) => `the first browser’s push: ${note}`));
  report(result);
  return result;
}

// Device B opens a page; reaching 'ready' kicks the cycle that pulls what the
// other browser pushed. The leg is that one cycle, from the navigation.
async function pullOnOpen(
  b: Device,
  leg: string,
  links: number,
  runDir: string,
  appOrigin: string,
  options: Options,
): Promise<LegResult> {
  const { page } = b.app;
  const since = Date.now();
  await page.goto('/settings/data');
  await assertTraced(page);
  const throttle = await throttleCpu(page, options.cpuRate);
  let cycle: SyncSpan;
  try {
    cycle = await waitForSpan(
      page,
      (s) => s.name === 'cycle' && s.attrs?.kind !== 'initial' && s.start >= since,
    );
    await waitForDrain(page);
  } finally {
    await throttle.release();
  }
  return readLeg(b, page, leg, links, since, runDir, appOrigin, cycle.end);
}

// A bulk edit as a user makes one: Bulk edit → select → Edit tags → a new tag →
// Save. A tag the selection does not carry, so every selected link takes a
// write (the dialog skips a link already in the target state). Read on the
// editing browser from the Save, then on the other from its next page open.
async function bulkEditLeg(
  a: Device,
  b: Device,
  size: number,
  links: number,
  runDir: string,
  appOrigin: string,
  options: Options,
): Promise<LegResult[]> {
  const name = `bulk edit of ${size.toLocaleString('en-US')}`;
  const onto = `onto ${links.toLocaleString('en-US')}`;
  console.log(`\n${name} (${onto})`);
  const { page } = a.app;
  await openSettled(page, ALL_LINKS_VIEW);
  const edited = await selectLinks(page, size);

  await toolbarAction(page, 'Edit tags');
  const dialog = page.getByRole('dialog', { name: 'Edit tags' });
  const tag = `bulk-${size}-${Date.now().toString(36)}`;
  await dialog.getByPlaceholder('Search or create tags…').fill(tag);
  await dialog.getByRole('option', { name: `Create “${tag}”` }).click();
  // Creating the tag is a write of its own, and its cycle would otherwise run
  // into the measured one.
  await waitForDrain(page);

  const push = await pushAfter(a, `${name}: push (${onto})`, links, runDir, appOrigin, options, {
    act: async () => {
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden({ timeout: LEG_TIMEOUT_MS });
    },
  });
  push.edited = edited;
  report(push);

  const pull = await pullOnOpen(b, `${name}: pull (${onto})`, links, runDir, appOrigin, options);
  pull.edited = edited;
  report(pull);
  return [push, pull];
}

// A permanent bulk delete: --delete links moved to Trash (unmeasured, and
// pulled by the other browser so its measured pull holds only the deletes),
// then deleted from the Trash view. No upload: each path is a `delete` op the
// commit carries, and the commit deletes the objects in R2 itself.
async function bulkDeleteLeg(
  a: Device,
  b: Device,
  size: number,
  links: number,
  runDir: string,
  appOrigin: string,
  options: Options,
): Promise<LegResult[]> {
  const name = `bulk delete of ${size.toLocaleString('en-US')}`;
  const onto = `from ${links.toLocaleString('en-US')}`;
  console.log(`\n${name} (${onto})`);
  const { page } = a.app;

  await openSettled(page, ALL_LINKS_VIEW);
  await selectLinks(page, size);
  await toolbarAction(page, 'Remove');
  await waitForDrain(page);
  await b.app.page.goto('/settings/data');
  await waitForDrain(b.app.page);

  await page.goto(TRASH_VIEW);
  await assertTraced(page);
  const deleted = await selectLinks(page, size);
  await toolbarAction(page, 'Delete permanently');
  const confirm = page.getByRole('alertdialog', { name: 'Delete permanently?' });
  const push = await pushAfter(a, `${name}: push (${onto})`, links, runDir, appOrigin, options, {
    act: async () => {
      await confirm.getByRole('button', { name: 'Delete permanently' }).click();
      await expect(confirm).toBeHidden({ timeout: LEG_TIMEOUT_MS });
    },
  });
  push.edited = deleted;
  report(push);

  const pull = await pullOnOpen(b, `${name}: pull (${onto})`, links, runDir, appOrigin, options);
  pull.edited = deleted;
  report(pull);
  return [push, pull];
}

// Read the editing browser's side of a bulk leg: `act` makes the write, and the
// leg runs from it to a drained queue. Its own page, not a navigation — the
// cycle under measurement keeps running and keeps its spans.
async function pushAfter(
  a: Device,
  leg: string,
  links: number,
  runDir: string,
  appOrigin: string,
  options: Options,
  { act }: { act: () => Promise<void> },
): Promise<LegResult> {
  const { page } = a.app;
  const throttle = await throttleCpu(page, options.cpuRate);
  const since = Date.now();
  let written: number;
  let drain: Drain;
  try {
    await act();
    written = Date.now();
    drain = await waitForDrain(page);
  } finally {
    await throttle.release();
  }
  const result = await readLeg(a, page, leg, links, since, runDir, appOrigin);
  result.notes.push(
    `the write (click → dialog closed) ${seconds(written - since)}; ` +
      `sync after it ${seconds(result.window.until - written)}`,
  );
  result.notes.push(...drainNotes(drain));
  return result;
}

// Open `path` and wait out the cycle the page kicks on reaching 'ready', before the
// leg writes. After a push of its own that cycle is no quick check: a push that
// went through the fallback leaves the cursor below its own commits
// (web-react sync/engine.ts, fallbackCycle), so the next cycle lists every one of
// them back — ~23,000 ops at 10,000 links — and the leg's write would queue
// behind it.
async function openSettled(page: Page, path: string): Promise<void> {
  const since = Date.now();
  await page.goto(path);
  await assertTraced(page);
  await waitForDrain(page, since);
}

// Enter Bulk edit on the current links view and select `size` links in display
// order: one checkbox at a time below a page, else Select all — which takes every
// loaded row, so it can overshoot — growing the page with "Show more" until it
// covers `size` or the view runs out. Returns how many are selected, from the
// toolbar's own count.
async function selectLinks(page: Page, size: number): Promise<number> {
  await page.getByRole('button', { name: 'Bulk edit' }).click();
  const selectAll = page.getByRole('checkbox', { name: 'Select all' });
  await expect(selectAll).toBeVisible();
  if (size < LINKS_PAGE) {
    // The first unchecked row, scrolled to: the list is virtualized, so only the
    // rows near the viewport exist to be clicked, and in display order the next
    // unchecked one is always the next row down.
    const unchecked = page.getByRole('checkbox', { name: 'Select link', checked: false });
    await expect(unchecked.first()).toBeVisible();
    while ((await selectedCount(page)) < size && (await unchecked.count()) > 0) {
      const box = unchecked.first();
      await box.scrollIntoViewIfNeeded();
      await box.click();
    }
  } else {
    const more = page.getByRole('button', { name: 'Show more' });
    for (;;) {
      if ((await selectAll.getAttribute('aria-checked')) !== 'true') await selectAll.click();
      await expect(selectAll).toHaveAttribute('aria-checked', 'true');
      if ((await selectedCount(page)) >= size || !(await more.isVisible())) break;
      await more.click();
      // The new page's rows arrive unselected, which unchecks Select all.
      await expect(selectAll).not.toHaveAttribute('aria-checked', 'true');
    }
  }
  return selectedCount(page);
}

async function selectedCount(page: Page): Promise<number> {
  const text = await page.getByText(/^\d+ selected$/).innerText();
  return Number.parseInt(text, 10);
}

// A bulk-edit toolbar action by name. Below the toolbar's collapse width the
// secondary ones live in its ⋯ menu (bulk-edit-toolbar.tsx, COLLAPSE_WIDTH).
async function toolbarAction(page: Page, name: string): Promise<void> {
  const inline = page.getByRole('button', { name, exact: true });
  if (await inline.isVisible()) {
    await inline.click();
    return;
  }
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

// Fetch what the pull fetched, with nothing around the fetch: see THE LEGS above.
async function floorLeg(
  b: Device,
  links: number,
  runDir: string,
  appOrigin: string,
  pull: LegResult,
): Promise<LegResult> {
  const leg = `floor (GETs of the pull’s blobs)`;
  console.log(`\n${leg}`);
  const urls = (await b.net.signedGets()).slice(0, FLOOR_SAMPLE);
  if (urls.length === 0) throw new Error('the pull minted no GET URL the floor could reuse');
  const { page } = b.app;
  const since = Date.now();
  const floor: FloorReading[] = await page.evaluate(
    async ({ urls, levels }) => {
      const readings = [];
      for (const concurrency of levels) {
        const durations: number[] = [];
        let failed = 0;
        let next = 0;
        const started = performance.now();
        await Promise.all(
          Array.from({ length: concurrency }, async () => {
            while (next < urls.length) {
              const { url, authorization } = urls[next++];
              const t0 = performance.now();
              try {
                // Read as the engine reads (web-react sync/r2.ts getBlob): a
                // blob-route token goes as a POST body, which is never
                // preflighted; a presign is a plain GET.
                const res = await fetch(
                  url,
                  authorization
                    ? { method: 'POST', body: authorization }
                    : { method: 'GET', cache: 'no-store' },
                );
                await res.arrayBuffer();
                if (!res.ok) failed++;
              } catch {
                failed++;
              }
              durations.push(performance.now() - t0);
            }
          }),
        );
        const wallMs = performance.now() - started;
        durations.sort((x, y) => x - y);
        readings.push({
          concurrency,
          n: urls.length,
          wallMs: Math.round(wallMs),
          p50Ms: Math.round(durations[Math.floor(durations.length * 0.5)] ?? 0),
          p95Ms: Math.round(durations[Math.floor(durations.length * 0.95)] ?? 0),
          perSecond: Math.round((urls.length / wallMs) * 10000) / 10,
          failed,
        });
      }
      return readings;
    },
    { urls, levels: FLOOR_LEVELS },
  );
  const result = await readLeg(b, page, leg, links, since, runDir, appOrigin, Date.now());
  result.floor = floor;
  for (const r of floor) {
    result.highlights.push(
      `${r.concurrency} at once: ${r.perSecond}/s, p50 ${r.p50Ms} ms, p95 ${r.p95Ms} ms` +
        `${r.failed ? `, ${r.failed} failed` : ''}`,
    );
  }
  // The comparison the leg exists for: the engine's GET rate over its whole
  // download, against the best this browser managed with nothing around it.
  const engine = pull.phases.find((p) => p.name === 'blob.get');
  const download = pull.phases.find((p) => p.name === 'download');
  const best = Math.max(...floor.map((r) => r.perSecond));
  if (engine && download && download.wallMs > 0) {
    const rate = engine.count / (download.wallMs / 1000);
    result.highlights.push(
      `the pull’s engine fetched ${rate.toFixed(1)}/s over its download phase; ` +
        `the best floor is ${best}/s (${(best / Math.max(rate, 0.001)).toFixed(1)}×)`,
    );
  }
  report(result);
  return result;
}

// --- reading a leg -----------------------------------------------------------------

async function readLeg(
  device: Device,
  page: Page,
  leg: string,
  links: number,
  since: number,
  runDir: string,
  appOrigin: string,
  until?: number,
): Promise<LegResult> {
  const { spans, dropped } = await readTrace(page);
  const lastCycle = Math.max(
    0,
    ...spans.filter((s) => s.name === 'cycle' && s.end >= since).map((s) => s.end),
  );
  const window = { since, until: until ?? (lastCycle || Date.now()) };
  const requests: NetRequest[] = device.net.requests();
  const phases = summarizeSyncTrace(spans, window);
  const network = summarizeNetwork(requests, appOrigin, window);
  const cycles = cyclesOf(spans, window.since, window.until);
  const mainThread = await mainThreadIn(page, window);
  const serviceWorker = await page.evaluate(() => !!navigator.serviceWorker?.controller);

  const slug = leg
    .toLowerCase()
    .replace(/\(.*\)/, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '-');
  const base = join(runDir, `${slug}-${links}`);
  const files = {
    spans: await writeJson(
      `${base}.spans.json`,
      spans.filter((s) => s.end >= window.since),
    ),
    network: await writeJson(
      `${base}.network.json`,
      requests.filter((r) => (r.end ?? r.start) >= window.since && r.start <= window.until),
    ),
    waterfall: await writeJson(
      `${base}.waterfall.json`,
      waterfall(spans, requests, appOrigin, window),
    ),
  };

  const notes: string[] = [];
  if (dropped > 0) notes.push(`${dropped} span(s) dropped past the recorder’s bound`);
  // A response the service worker answered carries no Server-Timing the page
  // can read (network.ts, the ⚠ on hidden wires), so a leg whose every api call
  // was a GET — a deletes-only pull, its one `ops/list` — has nothing to check,
  // and an old deploy has to show itself on a request that went on the wire.
  const onTheWire = network.filter((n) => n.viaWorker < n.n);
  if (
    IS_STAGING &&
    onTheWire.length > 0 &&
    !onTheWire.some((n) => Object.keys(n.serverTiming).length > 0)
  ) {
    notes.push('no Server-Timing on any api response — is staging running this checkout?');
  }
  return {
    leg,
    links,
    wallMs: window.until - window.since,
    window,
    serviceWorker,
    phases,
    cycles,
    network,
    mainThread,
    highlights: highlights({
      phases,
      network,
      cycles,
      spans,
      wallMs: window.until - window.since,
      blockingMs: mainThread.blockingMs,
    }),
    notes,
    files,
  };
}

function report(result: LegResult): void {
  console.log(
    `  ${seconds(result.wallMs)} wall, service worker ${result.serviceWorker ? 'in front' : 'absent'}`,
  );
  for (const line of result.highlights) console.log(`  • ${line}`);
  for (const line of result.notes) console.log(`  ! ${line}`);
  if (result.phases.length > 0) {
    console.log(`\n${indent(formatSyncTraceSummary(result.phases))}`);
  }
  if (result.network.length > 0) console.log(`\n${indent(formatNetwork(result.network))}`);
  const server = formatServerTiming(result.network);
  if (server) console.log(`\n  bracemark-api Server-Timing:\n${server}`);
  console.log(`\n  waterfall: ${result.files.waterfall}`);
}

// --- page probes -------------------------------------------------------------------

interface TraceWindow {
  __bracemarkSyncTrace?: { spans: SyncSpan[]; dropped: number; clear(): void };
}

async function assertTraced(page: Page): Promise<void> {
  const traced = await page.evaluate(
    () => !!(window as unknown as TraceWindow).__bracemarkSyncTrace,
  );
  if (!traced) {
    throw new Error(
      `${page.url()} has no sync trace — the app predates web-react sync/trace.ts. ` +
        (IS_STAGING ? 'Deploy this checkout’s bracemark-web to staging first.' : ''),
    );
  }
}

async function clearTrace(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as TraceWindow).__bracemarkSyncTrace?.clear());
}

async function readTrace(page: Page): Promise<{ spans: SyncSpan[]; dropped: number }> {
  return page.evaluate(() => {
    const trace = (window as unknown as TraceWindow).__bracemarkSyncTrace;
    return { spans: trace ? [...trace.spans] : [], dropped: trace?.dropped ?? 0 };
  });
}

// What the drain loop needs from the trace, and no more: how many spans it holds
// (refused ones included, so a full recorder still reads as moving) and the
// `cycle` spans. Copying every span out on each poll — readTrace — took seconds
// at 10,000 links (~70,000 spans through Playwright's protocol), twice a second.
async function readCycles(
  page: Page,
): Promise<{ recorded: number; cycles: Pick<SyncSpan, 'end' | 'failed'>[] }> {
  return page.evaluate(() => {
    const trace = (window as unknown as TraceWindow).__bracemarkSyncTrace;
    if (!trace) return { recorded: 0, cycles: [] };
    const cycles = trace.spans
      .filter((s) => s.name === 'cycle')
      .map((s) => ({ end: s.end, failed: s.failed }));
    return { recorded: trace.spans.length + trace.dropped, cycles };
  });
}

async function waitForSpan(page: Page, match: (span: SyncSpan) => boolean): Promise<SyncSpan> {
  const deadline = Date.now() + LEG_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = (await readTrace(page)).spans.find(match);
    if (found) return found;
    await page.waitForTimeout(250);
  }
  throw new Error('timed out waiting for a sync cycle');
}

// The pending-ops queue's length, read straight from the app's IndexedDB
// (web-react data/db.ts: `bracemark-data`, store `pendingOps`) — the same rows
// the Data card's "N changes waiting to sync" counts, without a re-render
// between them and the reading.
async function pendingCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open('bracemark-data');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const req = db.transaction('pendingOps', 'readonly').objectStore('pendingOps').count();
            req.onsuccess = () => {
              db.close();
              resolve(req.result);
            };
            req.onerror = () => {
              db.close();
              reject(req.error);
            };
          } catch (error) {
            db.close();
            reject(error);
          }
        };
      }),
  );
}

// Out of the Import sub-view to the Data overview, where the Sync row and its
// action live (_data/data-section.tsx): the receipt is shown in the sub-view, and
// waitForDrain can press nothing it cannot see. The "Data" back link swaps the
// view in place — no navigation, so no cycle is interrupted.
async function backToDataOverview(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Data', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Data', exact: true })).toBeVisible();
}

// Settled: nothing queued, a cycle has finished since the queue was last seen
// holding anything, and the engine has recorded nothing new for QUIET_MS.
// Without navigating — a reload would abort the cycle under measurement and drop
// its spans with the document (the trap seed/steps.ts's waitForSync, which
// navigates, would set). Returns what it took: the presses, and the cycles that
// failed on the way.
//
// "Since last seen holding anything" is the time the busy poll READ the queue,
// taken before its reads. The cycle that empties the queue clears its ops after
// that read, so it ends after it, however long the polls take. Timing it from
// the first empty poll instead — after both of that poll's reads — waited
// forever at 10,000 links: a poll there took seconds, the draining cycle had
// ended before the clock was read, and an empty queue starts no other cycle.
interface Drain {
  nudges: number;
  retries: number;
  failedCycles: string[];
}

async function waitForDrain(page: Page, since = Date.now()): Promise<Drain> {
  // `since`: a cycle that ended after it counts as the settling one — the caller's
  // navigation, when the page's own on-open cycle is what it waits out.
  const started = since;
  const deadline = Date.now() + LEG_TIMEOUT_MS;
  // The Data card's single action (_data/data-section.tsx): "Retry" after a
  // failed cycle, "Sync now" after a clean one, nothing while a cycle runs.
  const action = page.getByRole('button', { name: /^(Sync now|Retry)$/ });
  let busyAt = started;
  let lastRecorded = -1;
  let lastChange = Date.now();
  let lastPending = -1;
  let lastReport = 0;
  let reportedRecorded = 0;
  let toldNoAction = false;
  const drain: Drain = { nudges: 0, retries: 0, failedCycles: [] };
  const settled = (cycles: readonly Pick<SyncSpan, 'end' | 'failed'>[]): Drain => ({
    ...drain,
    failedCycles: cycles.filter((s) => s.failed && s.end >= started).map((s) => s.failed ?? ''),
  });
  while (Date.now() < deadline) {
    const readAt = Date.now();
    const pending = await pendingCount(page);
    const { recorded, cycles } = await readCycles(page);
    const now = Date.now();
    if (recorded !== lastRecorded || pending !== lastPending) {
      lastRecorded = recorded;
      lastPending = pending;
      lastChange = now;
    }
    if (pending === 0) {
      const cycledSince = cycles.some((s) => s.end >= busyAt - 1000);
      if (cycledSince && now - lastChange >= QUIET_MS) return settled(cycles);
    } else {
      busyAt = readAt;
      if (now - lastReport > 10_000) {
        // The spans the engine recorded since the last line: a queue that reads the
        // same between two lines is idle at 0, and busy elsewhere (a long listing,
        // another path's downloads) otherwise.
        const busy = lastReport ? ` (${recorded - reportedRecorded} new spans)` : '';
        console.log(`  ${pending} waiting to sync${busy}`);
        lastReport = now;
        reportedRecorded = recorded;
      }
      if (now - lastChange >= STUCK_MS && !toldNoAction && !(await action.isVisible())) {
        const failed = cycles.at(-1)?.failed;
        console.log(
          `  the queue has not moved for a minute, and this page has no "Sync now" or "Retry"` +
            `${failed ? ` (the last cycle failed: ${failed})` : ''}`,
        );
        toldNoAction = true;
      }
      if (now - lastChange >= STUCK_MS && (await action.isVisible())) {
        const label = (await action.innerText()).trim();
        const failed = cycles.at(-1)?.failed;
        console.log(
          `  the queue has not moved for a minute — pressing "${label}"` +
            `${failed ? ` (the last cycle failed: ${failed})` : ''}`,
        );
        await action.click();
        if (label === 'Retry') drain.retries++;
        else drain.nudges++;
        lastChange = now;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error('timed out waiting for the queue to drain');
}

function drainNotes(drain: Drain): string[] {
  const notes: string[] = [];
  if (drain.failedCycles.length > 0) {
    notes.push(`${drain.failedCycles.length} cycle(s) failed: ${drain.failedCycles.join('; ')}`);
  }
  if (drain.retries > 0) {
    notes.push(`a failed cycle left the queue stuck; it took ${drain.retries} "Retry" press(es)`);
  }
  if (drain.nudges > 0) {
    notes.push(`the queue stalled and needed ${drain.nudges} "Sync now" nudge(s)`);
  }
  return notes;
}

// The main-thread instrument's long tasks that overlap the window (main-thread.ts
// installs it; its timestamps are the page's, so the window is moved onto them).
async function mainThreadIn(
  page: Page,
  range: { since: number; until: number },
): Promise<LegResult['mainThread']> {
  return page.evaluate(({ since, until }) => {
    const store = (
      window as unknown as {
        __mainThread?: { tasks: { start: number; duration: number }[]; flush(): void };
      }
    ).__mainThread;
    if (!store) return { longestTaskMs: 0, blockingMs: 0, longTasks: 0 };
    store.flush();
    const from = since - performance.timeOrigin;
    const to = until - performance.timeOrigin;
    const tasks = store.tasks.filter((t) => t.start + t.duration >= from && t.start <= to);
    return {
      longestTaskMs: Math.round(Math.max(0, ...tasks.map((t) => t.duration))),
      blockingMs: Math.round(tasks.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0)),
      longTasks: tasks.length,
    };
  }, range);
}

async function throttleCpu(page: Page, rate: number): Promise<{ release(): Promise<void> }> {
  if (rate <= 1) return { release: async () => undefined };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return {
    async release() {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await cdp.detach();
    },
  };
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
