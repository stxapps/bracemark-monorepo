import { useSyncExternalStore } from 'react';

// How long the JS thread is blocked during an import or an export — the native
// half of the measurement behind docs/data-lifecycle.md, _main-thread cost_.
// Web reads the browser's own `longtask` entries (e2e/measure/main-thread.ts);
// React Native has no Long Tasks API, so this measures the same thing the only
// way a JS runtime can see it from inside: a timer that should fire every
// TICK_MS, and how late it actually fires. A tick can't run while the thread is
// busy, so the lateness of the tick after a block IS the block, to within one
// tick.
//
// OFF unless the app starts it, and the app starts it only when the bundle was
// built with EXPO_PUBLIC_MEASURE_STALLS=1 — which only the measurement tool
// sets, in Metro's environment (e2e/measure/native.ts). A shipped build never
// runs the timer, and every export below is a no-op until `startStallProbe`.
//
// The window is the import or export run itself: its hook calls
// `beginStallWindow` when the run starts and `endStallWindow` when it settles
// (use-import-all-data.ts, use-export-all-data.ts). The reading is published
// for the Data view to render as text (`measure-stall-reading`), which is how
// the runner reads it back off the device's accessibility tree.

// The timer's period: a frame.
const TICK_MS = 16;
// A block shorter than this isn't a long task, in the web API's sense and here.
const LONG_MS = 50;
// Fixed work for the calibration: iterations, not a duration, so a slower engine
// or device stretches it. A tenth of web's calibration loop (1.5e8, same body),
// because Hermes interprets where V8 compiles; multiply web's reading by 0.1 to
// compare the two engines on one machine.
const CALIBRATION_ITERATIONS = 1.5e7;

export interface StallReading {
  label: string;
  wallMs: number;
  // The longest single block of the JS thread in the window.
  longestMs: number;
  // Every block's excess over LONG_MS, summed — web's total blocking time.
  blockingMs: number;
  // Blocks over LONG_MS.
  stalls: number;
}

export interface StallCalibration {
  iterations: number;
  // The fixed work's own duration, timed around the loop.
  workMs: number;
  // What the probe saw of it — the positive control. A probe that reads far
  // less than `workMs` would report a false "no stall" for every run.
  probeMs: number;
}

export interface StallProbeState {
  calibration?: StallCalibration;
  last?: StallReading;
}

interface OpenWindow {
  label: string;
  start: number;
  longest: number;
  blocking: number;
  stalls: number;
}

// The pure half, clock injected so the spec can drive it (stall-probe.spec.ts).
export function createStallMeter(now: () => number) {
  let last = now();
  let open: OpenWindow | null = null;

  const observe = (late: number) => {
    if (open === null || late <= LONG_MS) return;
    open.longest = Math.max(open.longest, late);
    open.blocking += late - LONG_MS;
    open.stalls += 1;
  };

  return {
    // One timer fire: how late was it?
    tick() {
      const t = now();
      observe(t - last - TICK_MS);
      last = t;
    },
    isOpen(): boolean {
      return open !== null;
    },
    begin(label: string) {
      const t = now();
      last = t;
      open = { label, start: t, longest: 0, blocking: 0, stalls: 0 };
    },
    // Closing counts the block still in progress: a run's LAST chunk settles
    // the promise that calls this before any tick has run after it, and without
    // this it would never be seen — the final stall of every run, dropped.
    // `label`, when given, closes only that window — so the calibration can't
    // close a run's window that opened meanwhile.
    end(label?: string): StallReading | null {
      if (open === null || (label !== undefined && open.label !== label)) return null;
      const t = now();
      observe(t - last - TICK_MS);
      last = t;
      const reading: StallReading = {
        label: open.label,
        wallMs: Math.round(t - open.start),
        longestMs: Math.round(open.longest),
        blockingMs: Math.round(open.blocking),
        stalls: open.stalls,
      };
      open = null;
      return reading;
    },
  };
}

type Meter = ReturnType<typeof createStallMeter>;

let meter: Meter | null = null;
let state: StallProbeState = {};
const listeners = new Set<() => void>();

function publish(next: StallProbeState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function startStallProbe(): void {
  if (meter !== null) return;
  const running = createStallMeter(() => performance.now());
  meter = running;
  setInterval(() => running.tick(), TICK_MS);
  // Once, a moment after start-up has settled: the fixed work, run as its own
  // task so the ticks see it exactly as they would see an import's chunk.
  setTimeout(() => {
    // A run already measuring owns the window; skip rather than steal it.
    if (running.isOpen()) return;
    running.begin('calibration');
    setTimeout(() => {
      const started = performance.now();
      let sum = 0;
      for (let i = 0; i < CALIBRATION_ITERATIONS; i++) sum += i % 7;
      const workMs = performance.now() - started;
      // Read back so the loop can't be optimized away.
      if (sum < 0) throw new Error('unreachable');
      // Close after a few ticks have run, so the block is seen by a tick and
      // not only by `end()`'s pending-gap arm.
      setTimeout(() => {
        const reading = running.end('calibration');
        if (reading === null) return;
        publish({
          ...state,
          calibration: {
            iterations: CALIBRATION_ITERATIONS,
            workMs: Math.round(workMs),
            probeMs: reading.longestMs,
          },
        });
      }, 100);
    }, 50);
  }, 1500);
}

export function beginStallWindow(label: string): void {
  meter?.begin(label);
}

export function endStallWindow(): void {
  const reading = meter?.end();
  if (reading) publish({ ...state, last: reading });
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// null when the probe was never started — the readout renders nothing.
export function useStallProbe(): StallProbeState | null {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  return meter === null ? null : current;
}
