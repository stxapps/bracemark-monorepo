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
// How often a device runs the orphaned-file sweep for an account. Each run
// decodes every entity.
export const ORPHAN_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
// The most blobs one run deletes. A backlog clears over runs rather than in
// one burst of queued deletes.
export const ORPHAN_SWEEP_MAX = 500;

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

// The bookkeeping the sweeps' gates read (both stores' SyncMetaRecord; expo's
// nullable columns are web's optional fields).
export interface SweepMeta {
  firstSyncDoneAt: number;
  unreadablePaths?: readonly string[] | null;
  unreadableRecordCompleteAt?: number | null;
  lastOrphanSweepAt?: number | null;
}

// Can the unreadable record vouch for this store? Only once a FULL LISTING (a
// first sync, or a fallback) has completed on this device with the record in
// place. Before that, an empty record proves nothing: builds from before the
// record skipped without recording, the cursor is past those paths, and no pull
// meets them again. A store whose row predates the record (every web row from
// before it, every expo row migration 1 brought up) reads as not complete, and
// the engines force one fallback to make it so: the fallback downloads every
// path missing here, a skipped one fails again, and this time it is recorded.
// Both sweeps refuse to run until then.
export function unreadableRecordComplete(meta: SweepMeta | undefined): boolean {
  const at = meta?.unreadableRecordCompleteAt;
  return at !== undefined && at !== null && at > 0;
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
// delete it for everyone. False when the entity can't be read (no bytes, or
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
    for (const item of Object.values(value)) strikeReferences(item, candidates);
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

// What one run deletes: at most ORPHAN_SWEEP_MAX of the candidates left.
export function orphansToDelete(candidates: Iterable<string>): string[] {
  const ids: string[] = [];
  for (const id of candidates) {
    if (ids.length >= ORPHAN_SWEEP_MAX) break;
    ids.push(id);
  }
  return ids;
}
