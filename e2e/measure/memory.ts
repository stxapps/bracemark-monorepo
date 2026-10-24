import { createWriteStream } from 'node:fs';

import { capture } from '../runner/process';

// The app's memory on an Android device, read from `dumpsys meminfo` — the
// second instrument of measure/data-mobile.ts, beside the stall probe. Added
// for docs/data-lifecycle.md, **2026-10-24, the statement leak**: every
// statement drizzle prepared stayed compiled on the connection, and a
// 10,000-link restore sync grew the native heap by ~320 MB with nothing else to
// show for it. The stall probe read it only indirectly, as exports that ran out
// of swap, and swung 8.8 s to 1.0 s between two runs.
//
// ANDROID ONLY, and that is not a gap to fill with the iOS simulator: the
// simulator is a Mac process with the Mac's memory, so it never swaps and never
// meets the per-app limit a phone's iOS kills an app at. Its footprint would
// show a leak's growth but nothing of what that growth costs.

// Megabytes, from the kB dumpsys prints.
export interface MemoryReading {
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

const mb = (kb: string) => Math.round(Number(kb) / 1024);

// Undefined when the app has no process, which dumpsys says as text; any other
// output it can't read throws, so a reworded dumpsys stops the run rather than
// recording zeros.
export function parseMeminfo(text: string): MemoryReading | undefined {
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
  return { nativeHeapMb: mb(columns[6]), pssMb: mb(pss[1]), swapMb: mb(swap[1]) };
}

export async function readMemory(
  deviceId: string,
  appId: string,
): Promise<MemoryReading | undefined> {
  const { stdout } = await capture('adb', ['-s', deviceId, 'shell', 'dumpsys', 'meminfo', appId], {
    allowFailure: true,
    timeoutMs: 30_000,
  });
  return parseMeminfo(stdout);
}

export function formatMemory(reading: MemoryReading | undefined): string {
  return reading ? `${reading.nativeHeapMb} MB (${reading.swapMb} MB swapped)` : '—';
}

// A reading every `intervalMs` to `path`, one JSON line each, until stopped —
// for the shape of a growth between two leg-end readings. Off by default: each
// dump is a binder call into the app, and a run that times stalls should not
// add work to the thread it times. One read in flight at a time, so a slow
// dump on a swapping guest delays the next instead of piling up.
export function traceMemory(
  deviceId: string,
  appId: string,
  path: string,
  intervalMs = 10_000,
): { stop(): Promise<void> } {
  const out = createWriteStream(path);
  let reading: Promise<void> | undefined;
  const sample = () => {
    if (reading) return;
    reading = readMemory(deviceId, appId)
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
