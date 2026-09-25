import { createWriteStream } from 'node:fs';
import { basename } from 'node:path';

import { type BrowserContext, type CDPSession, type Page } from '@playwright/test';

// How long a flow holds the page's main thread, which is the one number that
// decides whether a step belongs in a Web Worker (docs/data-lifecycle.md,
// _main-thread cost_). Total wall time does not: an import that runs for thirty
// seconds while its progress line keeps moving is fine, and one that freezes
// the tab for three is not. So the instrument is the browser's own:
//
//   - `longtask` entries: every task over 50 ms, which is the unit the
//     thresholds are written in. The longest one is the headline.
//   - `long-animation-frame` entries, when the browser has them (Chrome 123+):
//     the same stalls seen per frame, with the scripts that STARTED them — the
//     invoker, the function and the file. That is the entry point, not the
//     owner: promise continuations run inside the task that resolved them, so
//     an export's decode loop reads as Dexie's `IDBRequest.onsuccess`, and a
//     restore's classify loop as zip.js's `TextWriter`. Finding what consumed
//     the time takes `--trace` and the DevTools Bottom-Up tab over the task.
//
// Both observers are installed by an init script, so they are live before any
// of the app's code runs, and read back with `takeRecords()` so nothing is left
// in a queue that has not been delivered yet.
//
// ONE BLIND SPOT, and why it doesn't hide the flows: code that runs synchronously
// INSIDE a DevTools-protocol command — a `page.evaluate` body, or the `change`
// handler `setInputFiles` fires — is not reported as a long task (measured: a
// ~250 ms loop in `page.evaluate` read as none). The import's heavy steps all
// run after an `await` (the sync refresh, `file.arrayBuffer()`), as ordinary
// tasks, and export starts from a real click; both are seen. `calibrate` is the
// proof that the instrument sees a known stall on each run, not a hope that it
// does.

export interface LongTask {
  start: number;
  duration: number;
}

export interface FrameScript {
  duration: number;
  invoker: string;
  fn: string;
  url: string;
  char: number;
}

export interface LongFrame {
  start: number;
  duration: number;
  blockingDuration: number;
  scripts: FrameScript[];
}

export interface LegResult {
  leg: string;
  wallMs: number;
  // The single longest main-thread task in the window, 0 when there was none
  // over 50 ms.
  longestTaskMs: number;
  // Total blocking time: every long task's excess over 50 ms, summed.
  blockingMs: number;
  longTasks: number;
  // The frame that blocked longest, and the scripts that ran in it, longest
  // first. Absent when the browser has no long-animation-frame support or no
  // frame was long.
  worstFrame?: { durationMs: number; blockingMs: number; scripts: string[] };
  receipt: string;
  tracePath?: string;
}

// Installed once per context; every document the context opens afterwards
// carries it.
//
// ⚠ A STRING, not a function, and that is load-bearing. Playwright ships a
// function to the page as its source text, and tsx compiles this file with
// esbuild's `keepNames`, which wraps every named inner function in a
// `__name(fn, "observe")` call. `__name` is a helper in node's copy of the
// module and exists nowhere in the page, so a function-form init script throws
// a ReferenceError before it installs anything — silently, in a page Playwright
// isn't watching the console of. The only symptom was measureLeg's "no
// instrument" guard on the first leg.
const INSTRUMENT_SCRIPT = `(() => {
  const tasks = [];
  const frames = [];
  const observers = [];
  const observe = (type, onEntry) => {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) onEntry(entry);
    });
    observer.observe({ type, buffered: true });
    observers.push([observer, onEntry]);
  };
  observe('longtask', (entry) => {
    tasks.push({ start: entry.startTime, duration: entry.duration });
  });
  observe('long-animation-frame', (entry) => {
    frames.push({
      start: entry.startTime,
      duration: entry.duration,
      blockingDuration: entry.blockingDuration ?? 0,
      scripts: (entry.scripts ?? []).map((script) => ({
        duration: script.duration,
        invoker: script.invoker,
        fn: script.sourceFunctionName,
        url: script.sourceURL,
        char: script.sourceCharPosition,
      })),
    });
  });
  window.__mainThread = {
    tasks,
    frames,
    flush() {
      for (const [observer, onEntry] of observers) {
        for (const entry of observer.takeRecords()) onEntry(entry);
      }
    },
  };
})();`;

export async function instrument(context: BrowserContext): Promise<void> {
  await context.addInitScript(INSTRUMENT_SCRIPT);
}

interface MainThreadStore {
  tasks: LongTask[];
  frames: LongFrame[];
  flush(): void;
}

// The DevTools Performance panel's own categories, so a trace written here opens
// there exactly like one recorded by hand, JS samples included.
const TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'v8.execute',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'toplevel',
  'blink.console',
  'blink.user_timing',
  'latencyInfo',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
];

export interface MeasureOptions {
  // Chrome's CPU slowdown factor, applied for the window only — so account
  // creation (Argon2id) and the unmeasured setup around a leg run at full speed.
  cpuRate: number;
  // Write a DevTools trace of the window here, for the "which function owns the
  // long task" question the entries can only point at.
  tracePath?: string;
}

// Run `action` under the instrument and report what it did to the main thread.
// The window must not navigate: the observers and `performance.now()` both
// belong to one document, so a navigation would silently measure half a leg.
// That is checked, not assumed.
export async function measureLeg(
  page: Page,
  leg: string,
  options: MeasureOptions,
  action: () => Promise<string>,
): Promise<LegResult> {
  const cdp = await page.context().newCDPSession(page);
  const origin = await page.evaluate(() => performance.timeOrigin);
  const hasStore = await page.evaluate(() => '__mainThread' in window);
  if (!hasStore) {
    throw new Error('the page has no instrument — call instrument(context) before navigating');
  }

  if (options.tracePath) {
    await cdp.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      traceConfig: { includedCategories: TRACE_CATEGORIES },
    });
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: options.cpuRate });

  const started = Date.now();
  const since = await page.evaluate(() => performance.now());
  let receipt: string;
  try {
    receipt = await action();
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  const wallMs = Date.now() - started;
  const until = await page.evaluate(() => performance.now());
  if (options.tracePath) await endTrace(cdp, options.tracePath);

  if ((await page.evaluate(() => performance.timeOrigin)) !== origin) {
    throw new Error(`${leg}: the page navigated mid-measurement, so the numbers are partial`);
  }
  const { tasks, frames } = await page.evaluate(() => {
    const store = (window as unknown as { __mainThread: MainThreadStore }).__mainThread;
    store.flush();
    return { tasks: store.tasks, frames: store.frames };
  });
  await cdp.detach();

  // OVERLAP, not "started inside": a frame's start is the first task it holds,
  // which can precede the window by a few ms, and a task that runs into the
  // window blocked the page during it all the same.
  const inWindow = <T extends { start: number; duration: number }>(entries: T[]) =>
    entries.filter((entry) => entry.start + entry.duration >= since && entry.start <= until);
  const windowTasks = inWindow(tasks);
  const worst = inWindow(frames).sort((a, b) => b.blockingDuration - a.blockingDuration)[0];

  return {
    leg,
    wallMs,
    longestTaskMs: Math.round(Math.max(0, ...windowTasks.map((task) => task.duration))),
    blockingMs: Math.round(
      windowTasks.reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0),
    ),
    longTasks: windowTasks.length,
    ...(worst
      ? {
          worstFrame: {
            durationMs: Math.round(worst.duration),
            blockingMs: Math.round(worst.blockingDuration),
            scripts: [...worst.scripts]
              .sort((a, b) => b.duration - a.duration)
              .slice(0, 3)
              .map(describeScript),
          },
        }
      : {}),
    receipt,
    ...(options.tracePath ? { tracePath: options.tracePath } : {}),
  };
}

export interface Calibration {
  cpuRate: number;
  // The same fixed work, read at full speed and at `cpuRate`.
  baseMs: number;
  slowedMs: number;
}

// The positive control, run before any leg is believed. A leg that reports no
// long task is only good news if the instrument would have seen one, and the
// first version of this file proved that isn't a given: its observers never
// installed (see INSTRUMENT_SCRIPT), and every leg read a clean 0 ms. So a
// fixed amount of work — iterations, not a duration, so a slowdown has to
// stretch it — runs as an ordinary page task at 1x and at `cpuRate`, and the
// run stops unless both read as long tasks and the slowdown shows. The 1x
// reading doubles as a record of the machine's speed for comparing readings.
export async function calibrate(page: Page, cpuRate: number): Promise<Calibration> {
  // A timer, not the evaluate body itself: code run inside a DevTools-protocol
  // command is the blind spot described at the top.
  const busy = async () => {
    const sum = await page.evaluate(
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => {
            let x = 0;
            for (let i = 0; i < 1.5e8; i++) x += i % 7;
            resolve(String(x));
          }, 0),
        ),
    );
    return sum;
  };
  const base = await measureLeg(page, 'calibration 1x', { cpuRate: 1 }, busy);
  const slowed = await measureLeg(page, `calibration ${cpuRate}x`, { cpuRate }, busy);

  if (base.longestTaskMs < 50) {
    throw new Error(
      `the instrument saw no long task for a known stall (read ${base.longestTaskMs} ms) — ` +
        'every leg would report a false 0 ms',
    );
  }
  // Half the expected stretch is the bar: throttling is not exact, but a
  // slowdown that didn't apply reads as ~1x, far under it.
  const expected = base.longestTaskMs * (1 + (cpuRate - 1) / 2);
  if (cpuRate > 1 && slowed.longestTaskMs < expected) {
    throw new Error(
      `the ${cpuRate}x CPU slowdown did not apply: the same work read ` +
        `${base.longestTaskMs} ms at 1x and ${slowed.longestTaskMs} ms at ${cpuRate}x`,
    );
  }
  return { cpuRate, baseMs: base.longestTaskMs, slowedMs: slowed.longestTaskMs };
}

function describeScript(script: FrameScript): string {
  const where = script.url ? `${basename(script.url)}:${script.char}` : 'inline';
  const fn = script.fn || '(anonymous)';
  return `${Math.round(script.duration)} ms ${script.invoker} → ${fn} @ ${where}`;
}

// The trace comes back as a stream handle, read in chunks; it can run to
// hundreds of MB for a large import, so it goes straight to disk.
async function endTrace(cdp: CDPSession, path: string): Promise<void> {
  const complete = new Promise<string>((resolve, reject) => {
    cdp.once('Tracing.tracingComplete', (event) => {
      if (event.stream) resolve(event.stream);
      else reject(new Error('the trace finished without a stream'));
    });
  });
  await cdp.send('Tracing.end');
  const handle = await complete;

  const out = createWriteStream(path);
  try {
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle });
      out.write(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
      if (chunk.eof) break;
    }
  } finally {
    await cdp.send('IO.close', { handle });
    await new Promise<void>((resolve, reject) =>
      out.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
  }
}
