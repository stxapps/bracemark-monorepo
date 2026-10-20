// A long-running job's progress tick: how many units are done, out of how many.
// One shape for every determinate counter in the apps — the blocking first sync's
// gate (sync/status.ts aliases it as InitialSyncProgressFn), the batched `files/`
// fetch behind an export, the export's own gather pass — so a UI that renders a bar
// can accept any of them without each caller re-spelling the signature.
//
// Two numbers rather than a struct because these fire PER UNIT: once per decrypted
// record on a first sync, several hundred times on a large library. The struct is
// allocated once per flush, by the consumer that throttles.
//
// `total` is a fact, not an estimate, at every site that reports one: each job counts
// its work before it starts (the first sync lists every file and subtracts what is
// already local, the export reads the namespace, the batched fetch counts the paths it
// will pull). A denominator that can't be invented is what lets the UI show a real bar
// instead of an indeterminate one easing toward 90%.
//
// `done` climbs monotonically to meet it, and every unit ticks exactly once —
// including the ones a run cannot finish (a path deleted between the listing and the
// GET, a URL that never came back). A counter that ignored those would stop short of
// its total and read as a hang.
export type ProgressFn = (done: number, total: number) => void;

// How often a progress readout may repaint. ~10 a second is the rate at which a
// climbing number reads as RUNNING rather than stepping, and still slower than
// anyone can read the digits, so going faster buys nothing visible. It is a cap
// on renders, not on ticks: the engines report per unit (hundreds a second on a
// large pull, 96 transfers in flight), and an unthrottled feed would be hundreds
// of renders a second competing with the crypto for the same thread. What makes
// the number move in small steps is the UNIT, not this interval — a counter fed
// once per committed chunk moves in hundreds however often it repaints, which is
// why the push reports per transfer (docs/local-first-sync.md, _progress_).
//
// One value for every surface — the two gates, both Data cards, the browser
// extension's popup — so a sync looks the same speed wherever it is watched.
// The bars ease over about two of these (a CSS/Reanimated transition), which is
// what keeps the bar itself continuous between repaints.
export const PROGRESS_FLUSH_MS = 100;

// Trailing-edge coalescer between a per-unit progress feed and something that
// repaints: every `report` overwrites the pending value, and at most one flush
// is scheduled at a time, so a burst of units costs one repaint. TRAILING, not
// leading, on purpose: a cycle that finishes inside one interval never paints a
// bar at all, which is the flash a 1-change sync would otherwise draw.
//
// Lives here rather than in either engine because a cadence is not an engine's
// policy — the engines are React-free and one of them also runs in the browser
// extension's service worker, whose "repaint" is a storage write.
export interface ProgressCoalescer<T> {
  report(value: T): void;
  // Push the pending value through now, rather than at the end of its window —
  // the last tick of a run, so a bar held on screen after it is a full one.
  flush(): void;
  // Drop the pending value and any scheduled flush.
  cancel(): void;
}

export function createProgressCoalescer<T>(
  onFlush: (value: T) => void,
  intervalMs: number = PROGRESS_FLUSH_MS,
): ProgressCoalescer<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { value: T } | null = null;
  const run = () => {
    timer = null;
    const next = pending;
    pending = null;
    if (next) onFlush(next.value);
  };
  return {
    report(value) {
      pending = { value };
      timer ??= setTimeout(run, intervalMs);
    },
    flush() {
      if (timer !== null) clearTimeout(timer);
      run();
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

// A counter over a known set of units that ticks each one EXACTLY ONCE, however
// many times it is reported — the "every unit ticks exactly once" rule above,
// made structural for a job that can touch a unit twice (a push's second pass
// re-sends what its first pass failed). Reports `(0, total)` on creation, so the
// denominator is on screen before the first unit lands; reports nothing at all
// for an empty set.
export function createUnitCounter(total: number, onProgress?: ProgressFn): (unit: string) => void {
  if (!onProgress || total <= 0) return () => undefined;
  const seen = new Set<string>();
  onProgress(0, total);
  return (unit) => {
    if (seen.has(unit) || seen.size >= total) return;
    seen.add(unit);
    onProgress(seen.size, total);
  };
}

// Whole percent for a progress readout. FLOORED, so the readout says 100% only
// when the last unit has landed — rounding put "100%" beside "996 of 1,000",
// which reads as a bar that finished and then didn't. Guards the two inputs a
// package boundary can't promise: a zero total (NaN) and an overshoot.
export function progressPercent(done: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
}
