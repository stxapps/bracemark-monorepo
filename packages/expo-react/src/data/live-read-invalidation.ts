// Explicit invalidation for writes that expo-sqlite's native change listener
// cannot observe. Its listener is backed by sqlite3_update_hook, and SQLite
// does not invoke that hook for a whole-table DELETE that takes the truncate
// optimization. Keep that fast delete path for library-sized wipes, then send
// one table-level invalidation through this tiny process-local channel.
//
// The same channel carries the bulk-write HOLD (holdLiveReads below).

type LiveReadInvalidationListener = (tables: readonly string[]) => void;

const listeners = new Set<LiveReadInvalidationListener>();

export function subscribeToLiveReadInvalidations(
  listener: LiveReadInvalidationListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function invalidateLiveReads(tables: readonly string[]): void {
  for (const listener of listeners) listener(tables);
}

// --- the bulk-write hold ------------------------------------------------------

// Every read on screen names `items`, and a change event carries a table, not a
// path — so a restore's write chunk re-ran lists, tags, settings, the quota count
// and the links screen, and re-rendered them, once per WRITE_CHUNK. That re-run
// was most of each ~0.4–0.65 s restore stall (docs/data-lifecycle.md, _readings —
// expo_). While a hold is taken, useLiveRead only NOTES a change; the reads that
// missed one re-run together on the next flush.
//
// A flush comes every HELD_FLUSH_MS as well as on the last release, and not only
// on release, because the yields between write chunks keep the app usable during
// an import. The user can edit a link meanwhile, and a hold for the whole run
// (~34 s at 10,000 links) would hide that edit for as long, which looks like a
// lost edit. So the bound is what an edit waits: at most one interval.
//
// Counted, so holds can nest; each release function is idempotent.
export const HELD_FLUSH_MS = 2000;

let holdCount = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;
const flushListeners = new Set<() => void>();

function flushHeld(): void {
  for (const listener of flushListeners) listener();
}

export function holdLiveReads(): () => void {
  holdCount += 1;
  if (holdCount === 1) flushTimer = setInterval(flushHeld, HELD_FLUSH_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holdCount -= 1;
    if (holdCount > 0) return;
    if (flushTimer !== null) clearInterval(flushTimer);
    flushTimer = null;
    flushHeld();
  };
}

export function liveReadsHeld(): boolean {
  return holdCount > 0;
}

// Called on each flush of a hold: the periodic one and the last release.
export function subscribeToHeldFlushes(listener: () => void): () => void {
  flushListeners.add(listener);
  return () => flushListeners.delete(listener);
}
