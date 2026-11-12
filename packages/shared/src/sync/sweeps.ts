// The decision rules of the two janitors that queue REMOTE deletes from local
// absence: the dangling-extraction sweep and the orphaned-file sweep. Written
// once, here, for both platforms (web-react and expo-react
// data/sweep-*.ts), which keep only their store reads and their deletes. Two
// hand-kept copies of code that deletes user data on every device would drift
// apart without anything noticing.
//
// The reasoning lives in web-react's sweep headers (data/sweep-dangling-
// extractions.ts, data/sweep-orphan-files.ts) and in
// docs/link-extraction-keep.md, _removal, cleanup, export_. Each rule below is
// silent if dropped. None of them makes a sweep sound on its own: the caller
// must be a full-sync client, at the end of a successful cycle, inside its
// lock (the engines' SyncDeps.afterCycle).

import { EXTRACTIONS_PREFIX, FILES_PREFIX, idFromPath, LINKS_PREFIX, rekey } from './paths';

// How old a blob's server stamp must be before it can count as orphaned.
// Content is written before the reference that names it, and a device that
// pushed the blob and stalled gets this long to push the rest.
export const ORPHAN_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
// How far past the newest server stamp this device has pulled its own clock may
// run before the grace stops believing it (orphanGraceNow).
export const ORPHAN_CLOCK_SLACK_MS = 24 * 60 * 60 * 1000;
// How often a device runs the orphaned-file sweep for an account. Each run
// decodes every entity.
export const ORPHAN_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// The most blobs one run deletes. A backlog clears over runs rather than in
// one burst of queued deletes.
export const ORPHAN_SWEEP_MAX = 500;
// How soon the sweep runs again after a run that hit ORPHAN_SWEEP_MAX and left
// orphans behind. At the weekly interval a backlog drained at 500 a week: an
// account full of blobs that older builds leaked sat at its byte ceiling for
// months, with nothing the user could delete to make room. A day keeps the
// burst bounded and the scan to one a day, and clears the same backlog in
// about a seventh of the time.
export const ORPHAN_SWEEP_BACKLOG_INTERVAL_MS = 24 * 60 * 60 * 1000;

// The extractions whose link is absent here, minus those whose link a pull
// skipped as unreadable (absent here, not proven absent there). One link blob
// that fails on this device must not delete that link's extraction, and its
// image, screenshot and page copy, on every device.
export function danglingExtractionPaths(
  extractionPaths: readonly string[],
  presentLinkPaths: ReadonlySet<string>,
  unreadablePaths: ReadonlySet<string>,
): string[] {
  return extractionPaths.filter((path) => {
    const linkPath = rekey(path, EXTRACTIONS_PREFIX, LINKS_PREFIX);
    return !presentLinkPaths.has(linkPath) && !unreadablePaths.has(linkPath);
  });
}

// The order a push commits its metadata puts in. The dangling-extraction sweep
// reads "an extraction with no link" as garbage, and a push of more than one
// commit chunk (500 ops) commits chunks in order, one at a time, and sorts the
// queue by path: `extractions/` sorts before `links/`. So a large import with
// its previews arriving could commit a link's extraction in an earlier chunk
// than the link, and another device that cycled between the two commits would
// sweep it, and every blob it names, for everyone. Extractions go last, so a
// link is never later than its extraction. The relative order inside each group
// is kept. A link and its extraction in the SAME chunk are one log write, which is why
// the chunk boundary was the order's gap. It narrows the window, it does not close it: a
// link whose upload fails, or is superseded by a re-edit mid-cycle, stays queued while
// its extraction's succeeds and commits, so an extraction can still reach the log first.
export function extractionsLast<T extends { path: string }>(ops: readonly T[]): T[] {
  return [
    ...ops.filter((o) => !o.path.startsWith(EXTRACTIONS_PREFIX)),
    ...ops.filter((o) => o.path.startsWith(EXTRACTIONS_PREFIX)),
  ];
}

// The bookkeeping the sweeps' gates read (both stores' SyncMetaRecord; expo's
// nullable columns are web's optional fields).
export interface SweepMeta {
  firstSyncDoneAt: number;
  unreadablePaths?: readonly string[] | null;
  unreadableRecordCompleteAt?: number | null;
  lastOrphanSweepAt?: number | null;
  // The pull cursor's server stamp: the newest op this device has applied. The
  // only server clock the sweep has (orphanGraceNow).
  syncCursorUpdatedAt?: number;
}

// Can the unreadable record vouch for this store? Only once a FULL LISTING (a
// first sync, or a fallback) has completed on this device with the record in
// place. Before that, an empty record proves nothing: builds from before the
// record skipped without recording, the cursor is past those paths, and no pull
// meets them again. A store whose row predates the record (every web row from
// before it, every expo row migration 1 brought up) reads as not complete, and
// the engines force a fallback to make it so (and again, on a backoff, while one
// fails): the fallback downloads every
// path missing here, a skipped one fails again, and this time it is recorded.
// Both sweeps refuse to run until then.
export function unreadableRecordComplete(meta: SweepMeta | undefined): boolean {
  const at = meta?.unreadableRecordCompleteAt;
  return at !== undefined && at !== null && at > 0;
}

// THE PROVING FALLBACK'S BACKOFF. A store whose record is not complete is sent
// to the fallback whatever the op log says (above), and a fallback lists the
// whole namespace and scans every local key before it pushes or pulls. A cycle
// that fails after that listing fails the same way on its retry — a blob in a
// format this build can't read, a queued op that will not push — and the
// engines' retry timer and every foreground wake would pay the listing again,
// for a failure the incremental path had cost one peek. So after a forced
// fallback fails, the next one waits. In between, a cycle is routed as the op
// log says, and the record just stays unproven: that only keeps the two sweeps
// off, which is the safe side, and nothing they do is urgent.
//
// In memory, per engine (one map per JS context), not on the bookkeeping row:
// what it bounds is a retry loop inside one session, and a new launch trying
// once more is cheap next to a migration to remember that it shouldn't.
export const PROOF_RETRY_DELAYS_MS: readonly number[] = [
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
];

export interface ProofBackoff {
  // Forced fallbacks that have failed in a row, which picks the next delay.
  failures: number;
  // When the next one may be forced (epoch ms).
  nextAt: number;
}

// May a cycle force the proving fallback now? Always, until one has failed.
export function proofAttemptDue(backoff: ProofBackoff | undefined, now: number): boolean {
  return !backoff || now >= backoff.nextAt;
}

// The backoff after a forced fallback failed. The last delay repeats.
export function proofAttemptFailed(backoff: ProofBackoff | undefined, now: number): ProofBackoff {
  const failures = (backoff?.failures ?? 0) + 1;
  const delays = PROOF_RETRY_DELAYS_MS;
  return { failures, nextAt: now + delays[Math.min(failures, delays.length) - 1] };
}

// May a dangling-extraction sweep start now? Not before the first sync, and not
// before the record is complete (above).
export function danglingSweepMayRun(meta: SweepMeta | undefined): boolean {
  return !!meta && meta.firstSyncDoneAt > 0 && unreadableRecordComplete(meta);
}

// May an orphaned-file sweep start now? Not before the first sync, not before
// the record is complete, not while ANY path is recorded unreadable (it can't
// tell which blob a skipped entity named, so any skip stops the whole run), and
// at most once an interval.
export function orphanSweepMayRun(meta: SweepMeta | undefined, now: number): boolean {
  if (!meta || !danglingSweepMayRun(meta)) return false;
  if (meta.unreadablePaths?.length) return false;
  const last = meta.lastOrphanSweepAt;
  return last === undefined || last === null || now - last >= ORPHAN_SWEEP_INTERVAL_MS;
}

// A pending op as both queues key it.
export interface PendingOpKey {
  path: string;
  writeId: string;
}

// The queue as a set of its writes, so a scan can tell whether a write landed
// while it ran (entityWrittenDuring).
export function pendingWrites(ops: readonly PendingOpKey[]): Set<string> {
  return new Set(ops.map((op) => `${op.path}\u0000${op.writeId}`));
}

// The "now" the 30-day grace is measured against. Blob stamps are the SERVER's
// clock, so measuring them against this device's clock lets a device whose clock
// runs 30 days or more ahead see every blob as old, including the ones another
// device uploaded minutes ago and has not named yet, and delete them for
// everyone. So the grace never runs past the newest server stamp this device has
// pulled plus a day of slack. An account with no recent activity measures from
// its last activity instead of today, which only spares blobs. A cursor of 0 (or
// none) leaves no candidates at all.
export function orphanGraceNow(deviceNow: number, meta: SweepMeta | undefined): number {
  const server = meta?.syncCursorUpdatedAt ?? 0;
  return Math.min(deviceNow, server + ORPHAN_CLOCK_SLACK_MS);
}

// The orphan candidates, as file ids: `files/` rows old enough by their SERVER
// stamp, and with nothing queued for their path. A stamp of 0 is a local,
// unpushed write's sync base, never a server's, so it never counts as old: the
// pending-op check is what excludes such a blob, and this keeps it excluded
// even if the queue is read wrong.
export function orphanCandidates(
  fileRows: readonly { path: string; updatedAt: number }[],
  queue: ReadonlySet<string>,
  now: number,
): Set<string> {
  const queued = new Set([...queue].map((key) => key.slice(0, key.indexOf('\u0000'))));
  const cutoff = now - ORPHAN_GRACE_MS;
  const ids = new Set<string>();
  for (const { path, updatedAt } of fileRows) {
    if (!path.startsWith(FILES_PREFIX)) continue;
    if (!(updatedAt > 0 && updatedAt < cutoff)) continue;
    if (queued.has(path)) continue;
    ids.add(idFromPath(path, FILES_PREFIX));
  }
  return ids;
}

// Strike every candidate one stored entity names. ANY STRING AT ANY DEPTH is a
// reference, not just the fields this build knows: a newer client may add a
// field or a namespace that names a blob, and an older device would otherwise
// delete it for everyone. An object's KEYS count as much as its values, for
// the same reason: a newer client may keep a map keyed by blob id, and striking
// one string too many only ever spares a blob. False when the entity can't be read (no bytes, or
// bytes that aren't JSON): nothing can then be proven unreferenced, and the run
// must stop.
export function strikeEntityReferences(
  bytes: Uint8Array | null | undefined,
  candidates: Set<string>,
  decoder: TextDecoder,
): boolean {
  if (!bytes) return false;
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    return false;
  }
  strikeReferences(value, candidates);
  return true;
}

function strikeReferences(value: unknown, candidates: Set<string>): void {
  if (typeof value === 'string') {
    candidates.delete(value);
  } else if (Array.isArray(value)) {
    for (const item of value) strikeReferences(item, candidates);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      candidates.delete(key);
      strikeReferences(item, candidates);
    }
  }
}

// Did an ENTITY write land while the scan ran? Its references weren't seen, so
// the run must stop rather than trust a stale answer. A `files/` write doesn't
// count: content names nothing.
export function entityWrittenDuring(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): boolean {
  for (const key of after) {
    if (!before.has(key) && !key.startsWith(FILES_PREFIX)) return true;
  }
  return false;
}

// The stamp a run that got to the end writes (SyncMetaRecord.lastOrphanSweepAt),
// which orphanSweepMayRun counts ORPHAN_SWEEP_INTERVAL_MS from. `now` for a run
// that deleted everything it found. A run the cap cut short (`capped`: orphans
// were left behind) writes a stamp that far in the past that the next run is due
// in ORPHAN_SWEEP_BACKLOG_INTERVAL_MS instead: the one field carries both
// schedules, so neither store needed a second one.
export function orphanSweepStamp(now: number, capped: boolean): number {
  return capped ? now - ORPHAN_SWEEP_INTERVAL_MS + ORPHAN_SWEEP_BACKLOG_INTERVAL_MS : now;
}

// What one run deletes: at most ORPHAN_SWEEP_MAX of the candidates left.
export function orphansToDelete(candidates: Iterable<string>): string[] {
  const ids: string[] = [];
  for (const id of candidates) {
    if (ids.length >= ORPHAN_SWEEP_MAX) break;
    ids.push(id);
  }
  return ids;
}
