import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type NativePlatform } from '../runner/cli';
import { capture } from '../runner/process';

// The app's memory, the second instrument of measure/data-mobile.ts beside the
// stall probe: `dumpsys meminfo` on Android, `footprint` on the iOS simulator.
// Added for docs/data-lifecycle.md, **2026-10-24, the statement leak**: every
// statement drizzle prepared stayed compiled on the connection, and a
// 10,000-link restore sync grew the native heap by ~320 MB with nothing else to
// show for it. The stall probe read it only indirectly, as exports that ran out
// of swap, and swung 8.8 s to 1.0 s between two runs.
//
// TWO QUESTIONS, AND iOS ANSWERS ONE. Growth — does memory climb with the work
// and stay climbed — is what found the leak, and both platforms read it. Cost —
// what that growth does to the app — is Android's alone: the simulator is a Mac
// process with the Mac's memory, so it never meets the per-app limit a phone's
// iOS kills an app at, and its compressor is the Mac's. So an iOS reading is a
// before → after, never a number to hold against a phone. It is worth having
// because the native half is not shared: expo-sqlite's iOS binding has no
// statement release step at all, and a leak in iOS-only native code would never
// show in an Android reading.

// Megabytes, from the kB dumpsys prints.
export interface AndroidMemory {
  source: 'dumpsys';
  // `Native Heap` → `Heap Alloc`: live malloc, so a freed block the allocator
  // keeps is not in it. SQLite's statements, expo-sqlite's and Hermes's
  // ArrayBuffers and every native module's allocations land here. Not the JS
  // heap: Hermes maps its own segments, which dumpsys counts elsewhere.
  nativeHeapMb: number;
  // The app's whole proportional share, and how much of it is in swap (zram on
  // the emulator). Swap is what slowed the exports, so it is the cost to read.
  pssMb: number;
  swapMb: number;
}

// Megabytes, from the bytes `footprint -j` writes.
export interface SimulatorMemory {
  source: 'footprint';
  // The dirty pages of the malloc zones (MALLOC_TINY/SMALL/LARGE/…): where
  // SQLite's statements and every native module's allocations land, as on
  // Android. Unlike dumpsys's Heap Alloc it is pages, not live blocks, so a
  // freed block the allocator still holds counts — compare it run with run.
  mallocMb: number;
  // phys_footprint, the number a device's iOS kills an app on. On the simulator
  // it is only the same kind of number: it reads the growth, not the headroom.
  footprintMb: number;
}

export type MemoryReading = AndroidMemory | SimulatorMemory;

const mb = (kb: string) => Math.round(Number(kb) / 1024);

// Undefined when the app has no process, which dumpsys says as text; any other
// output it can't read throws, so a reworded dumpsys stops the run rather than
// recording zeros.
export function parseMeminfo(text: string): AndroidMemory | undefined {
  if (/No process found/.test(text)) return undefined;
  // Pss Total, Private Dirty, Private Clean, SwapPss Dirty, Rss Total, Heap
  // Size, Heap Alloc, Heap Free — the column order Android 16 prints.
  const native = /^\s*Native Heap((?:\s+\d+){8})\s*$/m.exec(text);
  const pss = /TOTAL PSS:\s+(\d+)/.exec(text);
  const swap = /TOTAL SWAP PSS:\s+(\d+)/.exec(text);
  if (!native || !pss || !swap) {
    throw new Error(`dumpsys meminfo printed nothing this can read:\n${text.slice(0, 2000)}`);
  }
  const columns = native[1].trim().split(/\s+/);
  return {
    source: 'dumpsys',
    nativeHeapMb: mb(columns[6]),
    pssMb: mb(pss[1]),
    swapMb: mb(swap[1]),
  };
}

interface FootprintJson {
  unit?: string;
  processes?: {
    footprint?: number;
    categories?: Record<string, { dirty?: number }>;
    auxiliary?: { phys_footprint?: number };
  }[];
}

// As parseMeminfo: anything but the one shape it knows throws. The JSON, not
// the table, because the table's units float (B, KB, MB) row to row.
export function parseFootprint(text: string): SimulatorMemory {
  const json = JSON.parse(text) as FootprintJson;
  const app = json.processes?.length === 1 ? json.processes[0] : undefined;
  const physical = app?.auxiliary?.phys_footprint ?? app?.footprint;
  if (json.unit !== 'byte' || !app?.categories || typeof physical !== 'number') {
    throw new Error(`footprint wrote nothing this can read:\n${text.slice(0, 2000)}`);
  }
  const malloc = Object.entries(app.categories)
    .filter(([category]) => category.startsWith('MALLOC_'))
    .reduce((sum, [, { dirty = 0 }]) => sum + dirty, 0);
  const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return { source: 'footprint', mallocMb: toMb(malloc), footprintMb: toMb(physical) };
}

async function readMeminfo(deviceId: string, appId: string): Promise<AndroidMemory | undefined> {
  const { stdout } = await capture('adb', ['-s', deviceId, 'shell', 'dumpsys', 'meminfo', appId], {
    allowFailure: true,
    timeoutMs: 30_000,
  });
  return parseMeminfo(stdout);
}

// The app's pid on one simulator, from that simulator's own launchd — a
// `pgrep` would find the app on every booted simulator at once. The row reads
// `<pid>\t<status>\tUIKitApplication:<bundle id>[<hex>][rb-legacy]`, with `-`
// for a pid when the app is registered but not running.
async function simulatorPid(udid: string, appId: string): Promise<number | undefined> {
  const { stdout } = await capture('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], {
    timeoutMs: 30_000,
  });
  const label = `UIKitApplication:${appId}[`;
  const row = stdout.split('\n').find((line) => line.split('\t')[2]?.startsWith(label));
  const pid = Number(row?.split('\t')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

// Undefined when the app has no process, as on Android. A simulator app is a
// process of this Mac, so the host's `footprint` reads it like any other, from
// outside it. Its JSON goes only to a file.
async function readFootprint(udid: string, appId: string): Promise<SimulatorMemory | undefined> {
  const pid = await simulatorPid(udid, appId);
  if (pid === undefined) return undefined;
  const dir = await mkdtemp(join(tmpdir(), 'measure-footprint-'));
  try {
    const path = join(dir, 'footprint.json');
    await capture('footprint', ['-j', path, String(pid)], { timeoutMs: 30_000 });
    return parseFootprint(await readFile(path, 'utf8'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function readMemory(
  platform: NativePlatform,
  deviceId: string,
  appId: string,
): Promise<MemoryReading | undefined> {
  return platform === 'android' ? readMeminfo(deviceId, appId) : readFootprint(deviceId, appId);
}

export function formatMemory(reading: MemoryReading | undefined): string {
  if (!reading) return '—';
  return reading.source === 'dumpsys'
    ? `${reading.nativeHeapMb} MB heap (${reading.swapMb} MB swapped)`
    : `${reading.mallocMb} MB malloc (${reading.footprintMb} MB footprint)`;
}

// A reading every `intervalMs` to `path`, one JSON line each, until stopped —
// for the shape of a growth between two leg-end readings. Off by default: on
// Android each dump is a binder call into the app, and a run that times stalls
// should not add work to the thread it times. iOS's walks the app's address
// space from outside, which is cheaper and still not nothing. One read in
// flight at a time, so a slow dump on a swapping guest delays the next instead
// of piling up.
export function traceMemory(
  platform: NativePlatform,
  deviceId: string,
  appId: string,
  path: string,
  intervalMs = 10_000,
): { stop(): Promise<void> } {
  const out = createWriteStream(path);
  let reading: Promise<void> | undefined;
  const sample = () => {
    if (reading) return;
    reading = readMemory(platform, deviceId, appId)
      .then((memory) => {
        out.write(`${JSON.stringify({ at: new Date().toISOString(), ...memory })}\n`);
      })
      .catch((error: unknown) => {
        out.write(`${JSON.stringify({ at: new Date().toISOString(), error: String(error) })}\n`);
      })
      .finally(() => {
        reading = undefined;
      });
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      await reading;
      await new Promise<void>((resolve) => out.end(() => resolve()));
    },
  };
}
