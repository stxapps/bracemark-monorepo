import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { type BrowserContext, expect, type Page } from '@playwright/test';

import { formatSyncTraceSummary, summarizeSyncTrace, type SyncSpan } from '@stxapps/shared';

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
//
// The floor is GET-only on purpose. A PUT floor would have to write over the
// account's objects with bytes the app did not produce.

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
const LEGS = ['push', 'pull', 'incremental', 'floor'] as const;
type Leg = (typeof LEGS)[number];

interface Options {
  links: number[];
  legs: Set<Leg>;
  images: boolean;
  serviceWorkers: 'allow' | 'block';
  cpuRate: number;
  headed: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    links: [1000],
    legs: new Set(LEGS),
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
  await writeBackupLibrary(backup, links, { images: options.images });
  const results: LegResult[] = [];

  const a = await openDevice(`measure-sync-a-${links}`, options);
  let b: Device | undefined;
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
      b ??= await openDevice(`measure-sync-b-${links}`, options, a.app.credentials);
      const html = join(runDir, `bookmarks-${INCREMENTAL_LINKS}.html`);
      await writeBookmarksHtml(html, INCREMENTAL_LINKS);
      results.push(await incrementalLeg(a, b, html, links, runDir, appOrigin, options));
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

  // Device B opens a page; reaching 'ready' kicks the cycle that pulls them.
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
  const result = await readLeg(b, page, leg, links, since, runDir, appOrigin, cycle.end);
  result.notes.push(...drainNotes(pushed).map((note) => `the first browser’s push: ${note}`));
  report(result);
  return result;
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
  if (IS_STAGING && !network.some((n) => Object.keys(n.serverTiming).length > 0)) {
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

// Settled: nothing queued, a cycle has finished since the queue emptied, and
// the engine has recorded nothing new for QUIET_MS. Without navigating — a
// reload would abort the cycle under measurement and drop its spans with the
// document (the trap seed/steps.ts's waitForSync, which navigates, would set).
// Returns what it took: the presses, and the cycles that failed on the way.
interface Drain {
  nudges: number;
  retries: number;
  failedCycles: string[];
}

async function waitForDrain(page: Page): Promise<Drain> {
  const started = Date.now();
  const deadline = started + LEG_TIMEOUT_MS;
  // The Data card's single action (_data/data-section.tsx): "Retry" after a
  // failed cycle, "Sync now" after a clean one, nothing while a cycle runs.
  const action = page.getByRole('button', { name: /^(Sync now|Retry)$/ });
  let emptySince: number | null = null;
  let lastSpanCount = -1;
  let lastChange = Date.now();
  let lastPending = -1;
  let lastReport = 0;
  const drain: Drain = { nudges: 0, retries: 0, failedCycles: [] };
  const settled = (spans: readonly SyncSpan[]): Drain => ({
    ...drain,
    failedCycles: spans
      .filter((s) => s.name === 'cycle' && s.failed && s.end >= started)
      .map((s) => s.failed ?? ''),
  });
  while (Date.now() < deadline) {
    const pending = await pendingCount(page);
    const { spans } = await readTrace(page);
    const now = Date.now();
    if (spans.length !== lastSpanCount || pending !== lastPending) {
      lastSpanCount = spans.length;
      lastPending = pending;
      lastChange = now;
    }
    if (pending === 0) {
      emptySince ??= now;
      const empty = emptySince;
      const cycledSince = spans.some((s) => s.name === 'cycle' && s.end >= empty - 1000);
      if (cycledSince && now - lastChange >= QUIET_MS) return settled(spans);
    } else {
      emptySince = null;
      if (now - lastReport > 10_000) {
        console.log(`  ${pending} waiting to sync`);
        lastReport = now;
      }
      if (now - lastChange >= STUCK_MS && (await action.isVisible())) {
        const label = (await action.innerText()).trim();
        const failed = spans.filter((s) => s.name === 'cycle').at(-1)?.failed;
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
