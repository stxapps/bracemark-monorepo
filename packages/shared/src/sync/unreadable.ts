// The unreadable record's state rules, written once for both stores
// (web-react and expo-react sync-store.ts), which persist the result in their
// own way. The record is the paths a pull skipped because their blob did not
// open under its path (the engines' openPulled), on the account's bookkeeping
// row: past the cursor, the local store is complete only with that record
// beside it, and every reader that judges by local absence consults it (the
// dangling-extraction and orphaned-file sweeps). docs/local-first-sync.md,
// _crypto boundary_.
//
// A path leaves the record in three ways that are the server's answer — a pull
// stores it, a pull deletes it, or a RECHECK fetches it again and either opens
// it (and stores it) or meets a 404 — and in one that is a local fact: the
// recheck finds this device has written the path since the pull skipped it (a
// copy newer than the recorded stamp), so the record has nothing left to say
// about it. The write edge refuses a put to a recorded path (UnreadablePathError),
// which is what keeps that last way from being a way to drop a path the server
// still holds: a write built on this device's view of a path it could not open
// would overwrite the server's copy. A recheck that still can't open it keeps
// it. Nothing ever drops a path because it has failed for a long time, because
// forgetting it is what lets the orphaned-file sweep delete the blobs it names.
// That would happen on every device, including those that read it fine (a
// platform-only decrypt bug is the case that makes this real).
//
// The recheck exists because a skip is often transient (a corrupt transfer, or
// a delete whose op this device hasn't met yet), while the cursor is already
// past the path, so no pull meets it again unless it is rewritten. Without the
// recheck, one such path would keep the orphaned-file sweep off on this device
// for good.

// Wait this long after a path is recorded, then back off: the first try
// catches a transient failure soon, and a blob that stays unreadable settles
// at one fetch a week. The last delay repeats.
export const UNREADABLE_RECHECK_DELAYS_MS: readonly number[] = [
  60 * 60 * 1000,
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
];

// The most paths one recheck fetches. The record can be large if a key or
// reader bug made everything unreadable. The ones that still fail move to the
// back, so a large record is worked through over successive rechecks.
export const UNREADABLE_RECHECK_MAX = 100;

export interface UnreadableRecheck {
  // When the next recheck may run (epoch ms).
  dueAt: number;
  // Rechecks run since a path was last added, which picks the next delay.
  tries: number;
  // Each recorded path's server `updatedAt`, as the pull that skipped it saw
  // it. A healed blob is stored at this stamp, since a GET does not say which
  // version it served. A stamp older than the server's is the safe side: the
  // next pull that lists the path re-fetches it. Absent for a path recorded
  // before stamps were kept, and such a path is not stored by a recheck.
  stamps: Record<string, number>;
}

// The record as a store holds it.
export interface UnreadableState {
  paths: readonly string[];
  recheck: UnreadableRecheck | undefined;
}

export interface SkippedPath {
  path: string;
  updatedAt: number;
}

function recheckDelay(tries: number): number {
  const delays = UNREADABLE_RECHECK_DELAYS_MS;
  return delays[Math.min(tries, delays.length - 1)];
}

// A pull's skips added to the record, or null when nothing changes. A new path
// restarts the backoff, so it gets its own early try.
export function recordSkips(
  state: UnreadableState,
  skipped: readonly SkippedPath[],
  now: number,
): UnreadableState | null {
  if (skipped.length === 0) return null;
  const held = new Set(state.paths);
  const paths = [...state.paths];
  const stamps = { ...state.recheck?.stamps };
  let added = false;
  let restamped = false;
  for (const { path, updatedAt } of skipped) {
    if (!held.has(path)) {
      held.add(path);
      paths.push(path);
      added = true;
    }
    if (!(stamps[path] >= updatedAt)) {
      stamps[path] = updatedAt;
      restamped = true;
    }
  }
  if (!added && !restamped) return null;
  const recheck: UnreadableRecheck =
    added || !state.recheck
      ? { dueAt: now + recheckDelay(0), tries: 0, stamps }
      : { ...state.recheck, stamps };
  return { paths, recheck };
}

// The record without `settled` (paths a pull stored or deleted, or a recheck
// found gone), or null when none of them is in it. An emptied record has no
// recheck left to schedule.
export function forgetSettled(
  state: UnreadableState,
  settled: readonly string[],
): UnreadableState | null {
  if (state.paths.length === 0 || settled.length === 0) return null;
  const drop = new Set(settled);
  const paths = state.paths.filter((path) => !drop.has(path));
  if (paths.length === state.paths.length) return null;
  return { paths, recheck: withoutStamps(state.recheck, drop, paths.length) };
}

function withoutStamps(
  recheck: UnreadableRecheck | undefined,
  drop: ReadonlySet<string>,
  left: number,
): UnreadableRecheck | undefined {
  if (!recheck || left === 0) return undefined;
  const stamps: Record<string, number> = {};
  for (const [path, stamp] of Object.entries(recheck.stamps)) {
    if (!drop.has(path)) stamps[path] = stamp;
  }
  return { ...recheck, stamps };
}

// The paths a recheck should fetch now: none until it is due. A record with no
// schedule (written before rechecks existed) is due at once.
export function recheckBatch(state: UnreadableState, now: number): string[] {
  if (state.paths.length === 0) return [];
  if (state.recheck && now < state.recheck.dueAt) return [];
  return state.paths.slice(0, UNREADABLE_RECHECK_MAX);
}

// The record after a recheck of `checked`: `gone` (a 404) leaves it, the
// checked paths still held move to the back, and the next recheck is pushed
// out by the backoff. The paths it healed are already gone from `state` (the
// store's put forgets them), so they need no mention here.
export function afterRecheck(
  state: UnreadableState,
  checked: readonly string[],
  gone: readonly string[],
  now: number,
): UnreadableState {
  const drop = new Set(gone);
  const tried = new Set(checked);
  const kept = state.paths.filter((path) => !drop.has(path));
  const paths = [
    ...kept.filter((path) => !tried.has(path)),
    ...kept.filter((path) => tried.has(path)),
  ];
  const left = withoutStamps(state.recheck, drop, paths.length);
  if (paths.length === 0) return { paths, recheck: undefined };
  const tries = (state.recheck?.tries ?? 0) + 1;
  return {
    paths,
    recheck: { dueAt: now + recheckDelay(tries), tries, stamps: left?.stamps ?? {} },
  };
}

// Thrown by the write edge (both stores) for a put to a path in the record. This
// device could not open the server's copy, so a write built on its own view (a
// missing row reads as "never written", an older row as current) would overwrite
// what the server holds, and the recheck would then see a newer local copy and drop
// the path from the record. It is checked inside the write's own transaction, so a
// path recorded between a caller's decision and its write is still caught. The
// callers that decide what to extract skip such a link first (the pending reads take
// the record as `skipExtractionPaths`), and the capture flows ask before they fetch or
// write a blob (`assertExtractionWritable`), so this is the last line, not the first.
// It heals when the recheck opens the path, after which writes go through. A delete is
// not refused: it is the user's word, and it does not build on the unreadable copy.
export class UnreadablePathError extends Error {
  constructor(public readonly path: string) {
    super(`Not writing over a copy this device could not open: ${path}`);
    this.name = 'UnreadablePathError';
  }
}
