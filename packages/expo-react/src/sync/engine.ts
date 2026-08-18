// Hand-rolled sync engine — the expo sibling of web-react's sync/engine.ts,
// layer 2 in docs/local-first-sync.md. Same design, flow for flow (that file is
// the canonical doc for the protocol: the four-endpoint control plane, R2 as
// source of truth with the op log as a disposable accelerator, the compound
// `(updatedAt, path)` cursor, the commit phase ordering). Runs at the
// app/background level, NOT in React (no hooks). Comments here cover where the
// platform diverges:
//
//  - Storage: decrypted results land in the expo-sqlite store through
//    item-store.ts (which owns the row+junction single-transaction invariant),
//    not Dexie.
//  - Crypto: `encryptionKey` is the account's raw 32-byte key (native has no
//    non-extractable CryptoKey — see expo-crypto). Entity blobs pack/unpack in
//    JS (sync/crypto.ts); `files/` CONTENT encrypts/decrypts path-to-path in
//    the native layer (BracemarkFileCrypto), so file bytes never enter the JS heap.
//  - `files/` content lives DECRYPTED on disk (file-store.ts), not as bytes in
//    the row; the row's `hasDataFile` flag is web's "data absent = not yet
//    lazily downloaded" marker made explicit. loadEntityContent therefore
//    returns a plaintext File (render straight from its file:// uri), not bytes.
//  - No `pathFilter` in SyncDeps: selective sync exists for the bracemark-extension;
//    bracemark-expo is a full-sync client and this package has no other consumer.
//    Reintroduce it from web verbatim if a selective expo surface ever appears.

import type { File } from 'expo-file-system';

import { decryptEntity, decryptFile, encryptEntity, encryptFile } from '@stxapps/expo-crypto';
import {
  type ApiClient,
  apiErrorCode,
  chunk,
  type CommitResult,
  emptySyncOutcome,
  FILES_PREFIX,
  filesListEndpoint,
  filesSignEndpoint,
  type InitialSyncProgressFn,
  mapLimit,
  MAX_COMMIT_OPS,
  MAX_LIST_LIMIT,
  MAX_SIGN_PATHS,
  type OpEntry,
  opsCommitEndpoint,
  opsListEndpoint,
  type OpsListResponse,
  type ProgressFn,
  recordBlocked,
  type SignOp,
  type SyncOutcome,
  withRetry,
} from '@stxapps/shared';

import {
  dataFileFor,
  deleteDataFile,
  deleteDataFiles,
  ensureDataFilesDir,
  newTempEncFile,
} from '../data/file-store';
import {
  bulkGetItems,
  deleteItemsUnqueued,
  getItem,
  listItemUpdatedAts,
  markItemDataFileIfCurrent,
  putItemsUnqueued,
  stampItemUpdatedAts,
} from '../data/item-store';
import { clearDrainedOps, listPendingOps, type PendingOpRecord } from '../data/pending-store';
import { toItemRecord } from '../data/projection';
import { advanceCursor, getSyncMeta, markFirstSyncDone, resetCursor } from '../data/sync-store';
import { BlobRequestError, getBlob, getBlobToFile, putBlob, putBlobFromFile } from './r2';

// Everything the engine needs to run a sync, passed in by the caller (the sync
// provider) rather than read from session-store — so this module stays free of
// session/auth imports. The `username`/`encryptionKey` fields duplicate values
// the session already holds; that's deliberate decoupling, not redundancy.
export interface SyncDeps {
  username: string;
  // Raw AES-256-GCM key bytes from the session store (web holds a
  // non-extractable CryptoKey here); used to decrypt/encrypt R2 blobs.
  encryptionKey: Uint8Array;
  // The configured api client (createApiClient bound to this app's baseUrl + the
  // bearer-token authFetch). Passed in by the caller — the app's SyncProvider
  // reads it from useApiClient() — so the engine never reaches for an app-local
  // `api` singleton or app config.
  api: ApiClient;
}

// Batch/page sizes — this client's policy is to use the contract caps in full
// (anything ≤ the cap is valid; fewer round trips wins). A client-only knob, not
// contract.
const SIGN_BATCH = MAX_SIGN_PATHS;
const COMMIT_BATCH = MAX_COMMIT_OPS;
const OPS_PAGE = MAX_LIST_LIMIT;
const FILES_PAGE = MAX_LIST_LIMIT;

// Blob fan-out, split by direction because the two workloads bind on opposite
// resources (a bounded cap also keeps a first sync of thousands of files from
// opening thousands of sockets at once). Downloads are small index blobs (KB)
// over HTTP/2 and RTT-bound, so a wide fan-out cuts first-sync time and drains
// the presigned GET URLs sooner. Uploads can be MB-sized `files/` content, bound
// by uplink bandwidth (the native path-to-path pipeline keeps memory flat, but a
// phone's uplink saturates early), so they stay modest. Starting points — tune
// against a measured large first sync on device.
const DOWNLOAD_CONCURRENCY = 24;
const UPLOAD_CONCURRENCY = 8;

// One put-pipeline pass (pushPuts) signs, uploads, and commits a single chunk, so
// the chunk must fit BOTH the sign cap and the commit cap in one call each. Both
// are 1000 today; min() stays correct if they ever diverge. Bounding the chunk
// this way keeps each presigned PUT URL's mint-to-PUT latency inside its own
// chunk's upload window — for KB-sized index blobs that is well under the 5-min
// TTL on any push. A `files/` content chunk CAN outlive the TTL on a phone
// uplink; that is absorbed per blob, not per chunk: an expired-URL PUT fails only
// its own op (uploadBlobs), the chunk still commits the blobs that landed, and
// the rest retry next cycle under fresh URLs — monotonic progress either way,
// never a livelock.
const PUT_BATCH = Math.min(SIGN_BATCH, COMMIT_BATCH);

// A path under `files/` is heavy content (a saved page copy, screenshot). Per the
// doc, content is fetched LAZILY (on open/scroll), never eagerly on sync — so
// sync only tracks its `updatedAt` and downloads the always-resident index
// (links/tags/lists/settings). loadEntityContent() pulls a content blob on
// demand.
function isContentPath(path: string): boolean {
  return path.startsWith(FILES_PREFIX);
}

// One path with the server `updatedAt` to store against it.
interface Entry {
  path: string;
  updatedAt: number;
}

// Every public flow rides a retrying api client: a 429 (bracemark-api's rate limits
// are shared buckets — another device on the account, a NATed neighbor — so no
// amount of client pacing can rule one out), a 5xx, or a network blip gets a few
// backed-off retries (honoring the server's Retry-After) instead of failing the
// whole cycle into a sync-status error and waiting for a human. Retrying at the
// CALL level, not the cycle level, keeps already-paged op-log/list work; a run
// that still fails after the retries surfaces exactly as before. Wrapped per
// flow (not stored) so SyncDeps stays a plain value the callers construct freely.
function withRetryDeps(deps: SyncDeps): SyncDeps {
  return { ...deps, api: withRetry(deps.api) };
}

// --- public flows -----------------------------------------------------------

// First sync after a fresh sign-in on this device (docs flow #1). List the full
// R2 manifest, download + decrypt the index, build the local store — content is
// NOT pulled here. BLOCKING from the UI's point of view (the initial-sync gate
// shows the decrypting screen until this resolves).
//
// `onProgress` is the gate's counter feed, and it is a PARAMETER rather than a
// SyncDeps field on purpose: the provider builds one `deps` and hands it to both
// flows, so a field here would also fire on every background cycle — and a
// background cycle has no blocked UI waiting on a count. Passing it per call makes
// "only the blocking pull reports progress" structural instead of a convention.
// It stays silent through the listing below (no denominator exists yet, and
// inventing one is the fake-progress-bar failure); the first tick arrives once
// storeDownloads knows exactly how much it is about to fetch.
export async function runInitialSync(
  deps: SyncDeps,
  onProgress?: InitialSyncProgressFn,
): Promise<void> {
  deps = withRetryDeps(deps);
  const files = await listAllFiles(deps.api);
  await storeDownloads(deps, files, onProgress);
  // Cursor is the newest compound `(updatedAt, path)` among ALL listed files
  // (content included, even though its blob is deferred) — the same
  // reconstruction the fallback cycle does from its full listing.
  const newest = newestCursor(files);
  await markFirstSyncDone(deps.username, newest.updatedAt, newest.path);
}

// Single-flight per account. Overlapping calls (the post-ready background pull,
// an edit-triggered requestSync, a retry) coalesce: a caller during a run shares
// the in-flight promise, and at most one trailing rerun picks up whatever changed
// after that run's snapshot. Serializing cycles keeps two drains from
// double-committing the same pending ops and keeps cursor writes ordered
// (advanceCursor's forward-only guard covers out-of-order stragglers).
const inflightSyncs = new Map<string, Promise<SyncOutcome>>();
const rerunRequests = new Set<string>();

// Wait for an in-flight cycle (if any) to settle WITHOUT starting one — unlike
// calling runIncrementalSync, which kicks a fresh cycle when idle. For callers
// that need the engine quiescent before doing something destructive (the
// delete-all flow: a cycle that already read the pending queue could otherwise
// re-push ops after the server wipe). Swallows the cycle's rejection — the
// waiter only cares that it's over, not how it went (the cycle's own callers
// handle the error).
export async function awaitInflightSync(username: string): Promise<void> {
  await inflightSyncs.get(username)?.catch(() => undefined);
}

// A returning-visit sync (docs flow #2 + "a sync cycle"): reconcile, then push,
// then pull. Non-blocking — failures surface a quiet retry, they don't gate the
// UI. Routes itself to the download-authoritative fallback when the op log can't
// answer (wiped, compacted past the cursor, or behind it).
//
// REJECTS on a failed cycle — that's the contract every caller is written
// against (the sync provider's rejection branch sets its error status).
// Coalesced callers share the in-flight promise, so they share its rejection
// too — all of them handle it.
//
// RESOLVES with a SyncOutcome, because "it worked" is no longer the only good
// answer: a cycle can complete with part of the push refused by the plan/quota
// gate (signPushable, below). Callers that only care about failure can ignore
// the value; the provider maps it through shared's `bgStatusForOutcome` to show
// a `blocked-*` status (with the refused count) rather than a false 'idle'.
export function runIncrementalSync(deps: SyncDeps): Promise<SyncOutcome> {
  const key = deps.username;
  const inflight = inflightSyncs.get(key);
  if (inflight) {
    rerunRequests.add(key);
    return inflight;
  }
  const run = (async () => {
    try {
      // The LAST run's outcome is the answer, not the union: a trailing rerun
      // re-reads the same pending queue, so if it pushed cleanly the block is
      // genuinely gone (the user upgraded, or freed space mid-cycle).
      let outcome = await incrementalSyncOnce(deps);
      while (rerunRequests.delete(key)) outcome = await incrementalSyncOnce(deps);
      return outcome;
    } finally {
      inflightSyncs.delete(key);
      rerunRequests.delete(key);
    }
  })();
  inflightSyncs.set(key, run);
  return run;
}

async function incrementalSyncOnce(deps: SyncDeps): Promise<SyncOutcome> {
  deps = withRetryDeps(deps);
  // Collected DOWN the call chain (the cycles → pushPending → pushPuts) and
  // returned UP, so the provider can tell a clean cycle from one the quota gate
  // clipped without either of them inspecting an error.
  const outcome = emptySyncOutcome();
  const meta = await getSyncMeta(deps.username);
  // The cursor is the compound key (updatedAt, path); both halves go over the
  // wire as opsListEndpoint's `since` + `sincePath`. `since` is always sent
  // (even 0, for a seeded-but-empty new account) so the server's bounds can
  // route us; an empty `sincePath` is omitted (server reads it as the low
  // sentinel).
  const since = meta?.syncCursorUpdatedAt ?? 0;
  const sincePath = meta?.syncCursorPath ?? '';
  const pending = await listPendingOps(deps.username);

  // Peek the first page: its retained-range bounds decide incremental vs.
  // fallback before we commit to paging the op log.
  const first = await deps.api.call(opsListEndpoint, {
    since,
    sincePath: sincePath || undefined,
    limit: OPS_PAGE,
  });

  if (needsFallback(since, first)) {
    await fallbackCycle(deps, pending, outcome);
  } else {
    await incrementalCycle(deps, since, sincePath, first, pending, outcome);
  }
  return outcome;
}

// Lazy content fetch (docs "data model — metadata vs. content"): pull one
// `files/{id}.enc` blob on demand (open/scroll) and materialize it. The
// platform's shape of web's decrypt-and-cache-in-Dexie: the ciphertext downloads
// straight to a temp file, BracemarkFileCrypto decrypts it path-to-path into the
// file-store location (bytes never enter the JS heap), and the row's
// `hasDataFile` flag records the cache so re-views are instant and offline.
// Returns the plaintext File (e.g. expo-image renders its file:// uri directly),
// or undefined if the path isn't known locally — or no longer exists server-side
// (deleted on another device, the delete op not yet pulled; the next sync
// removes the record).
export async function loadEntityContent(deps: SyncDeps, path: string): Promise<File | undefined> {
  const rec = await getItem(path);
  if (!rec) return undefined;
  const plain = dataFileFor(path);
  if (rec.hasDataFile && plain.exists) return plain;

  const url = (await signPaths(withRetry(deps.api), 'get', [path])).get(path);
  if (!url) return undefined;

  const enc = newTempEncFile();
  try {
    try {
      await getBlobToFile(url, enc);
    } catch (err: unknown) {
      if (err instanceof BlobRequestError && err.status === 404) return undefined;
      throw err;
    }
    ensureDataFilesDir();
    // Clear any stale plaintext first (e.g. a leftover from a record that
    // changed server-side) so the outcome is deterministic and
    // platform-independent: the native decrypt does overwrite an existing target
    // (iOS atomic rename; Android delete-then-retry), but rather than lean on
    // those matching across every filesystem, we make "plain" absent up front.
    // It also gives a clean failure state — a decrypt that throws leaves no file
    // behind, and markItemDataFile (below) only runs on success, so the row and
    // disk stay consistent as "not downloaded" and the next call redoes the work.
    deleteDataFile(path);
    await decryptFile(enc.uri, plain.uri, deps.encryptionKey);
  } finally {
    if (enc.exists) enc.delete();
  }
  // Flag last, so a crash mid-materialize reads as "not downloaded" and the next
  // call simply redoes the work — and by compare-and-set on the stamp this fetch
  // started from: a sync pull can restamp the row mid-materialize (newer version,
  // flag reset, old file torn down), and marking blindly would pin the OLDER
  // plaintext under the newer stamp, served as current until the server moves
  // again. Losing the race discards the stale file and reports "not available";
  // the next call fetches the new version.
  if (!(await markItemDataFileIfCurrent(path, rec.updatedAt))) {
    deleteDataFile(path);
    return undefined;
  }
  return plain;
}

// The BATCH materializer — web engine's loadEntityContents, for flows that need
// many blobs resident at once (the export flow's download phase). Same
// semantics per path as loadEntityContent — fetch, native-decrypt to disk, mark
// the row, so re-runs are resumable — but signed in SIGN_BATCH pages (one
// `files/sign` call per ~1000 paths instead of one per file) and fetched at the
// upload fan-out (these are MB-sized media, not KB index blobs — web fans wider
// because its downloads are small). Already-materialized files are skipped (and
// don't count toward progress); a path that's unknown locally or 404s on GET
// (deleted on another device, the delete op not yet pulled) lands in
// `missingPaths` for the caller to report — never a thrown error. Any other
// failure rejects.
export async function loadEntityContents(
  deps: SyncDeps,
  paths: string[],
  onProgress?: ProgressFn,
): Promise<{ missingPaths: string[] }> {
  deps = withRetryDeps(deps);

  const records = await bulkGetItems(paths);
  const missingPaths: string[] = [];
  const wanted: string[] = [];
  // The stamp each fetch starts from, for the same compare-and-set flag write
  // loadEntityContent does (see there): a path restamped mid-fetch discards its
  // stale plaintext rather than pinning it under the new stamp.
  const baseStamps = new Map<string, number>();
  paths.forEach((path, i) => {
    const rec = records[i];
    if (!rec) missingPaths.push(path);
    else if (!rec.hasDataFile || !dataFileFor(path).exists) {
      wanted.push(path);
      baseStamps.set(path, rec.updatedAt);
    }
  });

  const total = wanted.length;
  let done = 0;
  const reportOne = (): void => {
    done += 1;
    onProgress?.(done, total);
  };
  onProgress?.(done, total);
  for (const batch of chunk(wanted, SIGN_BATCH)) {
    const urls = await signPaths(deps.api, 'get', batch);
    await mapLimit(batch, UPLOAD_CONCURRENCY, async (path) => {
      const url = urls.get(path);
      let fetched = false;
      if (url) {
        const enc = newTempEncFile();
        try {
          try {
            await getBlobToFile(url, enc);
            fetched = true;
          } catch (err: unknown) {
            if (!(err instanceof BlobRequestError && err.status === 404)) throw err;
          }
          if (fetched) {
            ensureDataFilesDir();
            // Same deterministic-overwrite + flag-last ordering as
            // loadEntityContent (see there).
            deleteDataFile(path);
            await decryptFile(enc.uri, dataFileFor(path).uri, deps.encryptionKey);
          }
        } finally {
          if (enc.exists) enc.delete();
        }
      }
      if (fetched) {
        // CAS-miss: the row moved mid-fetch — drop the stale plaintext; not a
        // `missingPaths` case (the blob existed; the caller re-reads the store).
        const marked = await markItemDataFileIfCurrent(path, baseStamps.get(path) ?? -1);
        if (!marked) deleteDataFile(path);
      } else missingPaths.push(path);
      reportOne();
    });
  }
  return { missingPaths };
}

// --- the cycle: incremental -------------------------------------------------

async function incrementalCycle(
  deps: SyncDeps,
  since: number,
  sincePath: string,
  first: OpsListResponse,
  pending: PendingOpRecord[],
  outcome: SyncOutcome,
): Promise<void> {
  // 1. Pull: page the op log via keyset, coalescing to the latest op per path.
  const serverOps = new Map<string, OpEntry>();
  let cursorUpdatedAt = since;
  let cursorPath = sincePath;
  let page = first;
  for (;;) {
    for (const op of page.ops) {
      serverOps.set(op.path, op);
      cursorUpdatedAt = op.updatedAt;
      cursorPath = op.path;
    }
    if (!page.hasMore) break;
    page = await deps.api.call(opsListEndpoint, {
      since: cursorUpdatedAt,
      sincePath: cursorPath || undefined,
      limit: OPS_PAGE,
    });
  }

  // 2. Reconcile pulled ops against the pending queue. A path with a pending op
  // is a local edit; LWW resolves a true conflict (server moved past our base)
  // the same way as a clean fast-forward — local-wins (upload) — so EVERY
  // pending op goes to the push set and the download set is only the
  // server-only paths. (Which side wins a true conflict is an open product
  // call; local-wins matches "the later PUT wins" and is what the deferred
  // conditional-write upgrade turns into a detected 412 + re-pull.)
  const pendingPaths = new Set(pending.map((p) => p.path));
  const downloads: Entry[] = [];
  const localDeletes: string[] = [];
  for (const op of serverOps.values()) {
    if (pendingPaths.has(op.path)) continue; // local-wins: keep our pending op, skip the server copy
    if (op.op === 'put') downloads.push({ path: op.path, updatedAt: op.updatedAt });
    else localDeletes.push(op.path);
  }

  // 3. Push, 4. Pull — disjoint sets, so order is a sensible default, not a
  // requirement (local changes durable first).
  const { committed, orphanedPaths } = await pushPending(deps, pending, outcome);
  // Complete the self-heal: a wedged op the push dropped (uploadBlobs) had its
  // path reserved for the push by the reconcile above, keeping the server's copy
  // OUT of the download set — re-add whatever this window shows for it, so the
  // heal restores the entity instead of leaving the path locally absent. (A path
  // with no op in the window stays absent until a fallback re-lists it — the op
  // that put it there is behind the cursor.)
  for (const path of orphanedPaths) {
    const op = serverOps.get(path);
    if (op?.op === 'put') downloads.push({ path: op.path, updatedAt: op.updatedAt });
  }
  await storeDownloads(deps, downloads);
  await applyDeletes(deps.username, localDeletes);

  // 5. Advance the cursor to the newest (updatedAt, path) seen across the whole
  // cycle — including our own just-committed uploads, so the next cycle doesn't
  // re-fetch them.
  for (const c of committed) {
    if (isNewer(c.updatedAt, c.path, cursorUpdatedAt, cursorPath)) {
      cursorUpdatedAt = c.updatedAt;
      cursorPath = c.path;
    }
  }
  await advanceCursor(deps.username, cursorUpdatedAt, cursorPath);
}

// --- the cycle: fallback (download-authoritative) ---------------------------

// When the op log can't reconstruct the delta, reconcile directly against a full
// R2 listing (docs "fallback full sync"). The server list is truth for every
// path WITHOUT a pending local op — so a server-side deletion is never
// resurrected and a stale leftover is dropped. A pending op is a genuine
// unsynced local intent, resolved exactly as the incremental cycle resolves it —
// local-wins — so a fallback (an infra event: log wiped/compacted/reset) never
// silently flips a conflict to server-wins: a pending edit is pushed over the
// server copy, and a pending delete is pushed rather than resurrected by the
// listing.
async function fallbackCycle(
  deps: SyncDeps,
  pending: PendingOpRecord[],
  outcome: SyncOutcome,
): Promise<void> {
  const files = await listAllFiles(deps.api);
  const serverFiles = new Map(files.map((f) => [f.path, f.updatedAt]));
  const pendingPaths = new Set(pending.map((p) => p.path));

  // One projection-only scan gives path → updatedAt without deserializing any
  // `data` blob (item-store.ts — web does the same with an IndexedDB key
  // cursor). It feeds BOTH reconcile directions below.
  const localUpdatedAt = await listItemUpdatedAts();

  // Server side: download anything new or newer than the stored local
  // `updatedAt` — except paths with a pending op, which local-wins reserves for
  // the push.
  const downloads = files.filter((f) => {
    if (pendingPaths.has(f.path)) return false;
    const local = localUpdatedAt.get(f.path);
    return local === undefined || f.updatedAt > local;
  });

  // Local side: a local-only path with no pending op was deleted on the server —
  // drop it. (A local-only path with a pending put is an unpushed create.)
  const localDeletes: string[] = [];
  for (const path of localUpdatedAt.keys()) {
    if (serverFiles.has(path) || pendingPaths.has(path)) continue;
    localDeletes.push(path);
  }

  // Push every pending op — including a delete whose object is already gone
  // server-side. The absence is ambiguous: usually another device committed the
  // delete (the re-commit costs one redundant op row), but it can also be OUR
  // OWN commit that crashed between the R2 delete and the DO write — and then
  // this retry is the only thing that ever logs the op (so incremental pullers
  // learn of the deletion) and frees the path's file_sizes quota entry. Commit
  // is idempotent on both stores, so pushing unconditionally is always safe;
  // dropping the op would leak the quota entry forever.
  const { committed, orphanedPaths } = await pushPending(deps, pending, outcome);
  // Same heal as the incremental cycle: a dropped op's path was excluded from the
  // download set above — re-add the listed server copy so it comes back.
  for (const path of orphanedPaths) {
    const updatedAt = serverFiles.get(path);
    if (updatedAt !== undefined) downloads.push({ path, updatedAt });
  }
  await storeDownloads(deps, downloads);
  await applyDeletes(deps.username, localDeletes);

  // Cursor = newest (updatedAt, path) across ALL pages plus our commits. This is
  // reconstructed straight from R2 with no op-log dependence — resetCursor, not
  // advanceCursor, because the cursor-ahead case intentionally LOWERS the cursor
  // back to reality.
  const newest = newestCursor(files, committed);
  await resetCursor(deps.username, newest.updatedAt, newest.path);
}

// --- push (the 3-round-trip commit protocol) --------------------------------

// Transient upload failures collected across the put phases (uploadBlobs) — the
// count decides whether the metadata phase may run and whether the cycle must
// reject; the first error is what it rejects with (the real transport failure,
// not a summary). An accumulator for the same reason SyncOutcome is one.
interface UploadFailures {
  count: number;
  firstError: unknown;
}

// Drain a set of pending ops: sign → PUT → commit (docs flow #3). Returns the
// committed results (R2's authoritative clock) so the caller can advance its
// cursor over its own writes, plus the paths of ops the self-heal dropped
// (uploadBlobs) so the caller can re-add their server copies to its download
// set. Removes each committed path from the queue; a `no_object` failure is left
// queued to re-PUT next drain.
//
// Runs in the global phase order [delete-metadata, delete-content, put-content,
// put-metadata] — the mirror pair of the multi-file-consistency rules (docs
// "multi-file consistency"): a create writes content before the metadata that
// references it; a delete removes that metadata before the content it
// referenced. So no crash or partial push ever leaves metadata pointing at a
// missing content file. Crucially each PHASE commits durably before the next,
// and each CHUNK within the put phases signs + uploads + commits as one unit
// (pushPuts) — so a presigned PUT URL never outlives its own chunk's upload
// window, and a push too large to finish inside one 5-min TTL still makes
// monotonic progress instead of livelocking on an all-up-front sign whose tail
// expires before it can be uploaded.
//
// THROWS after the phases when any upload transiently failed — not before them,
// so the cycle keeps its progress (committed chunks stay committed; failed ops
// stay queued for fresh URLs next drain), and not silently, because a rejection
// is the contract the caller schedules a retry and shows an error status through.
async function pushPending(
  deps: SyncDeps,
  ops: PendingOpRecord[],
  outcome: SyncOutcome,
): Promise<{ committed: CommitResult[]; orphanedPaths: string[] }> {
  if (ops.length === 0) return { committed: [], orphanedPaths: [] };

  const puts = ops.filter((o) => o.op === 'put');
  const deletes = ops.filter((o) => o.op === 'delete');
  const committed: CommitResult[] = [];
  const orphanedPaths: string[] = [];
  const failures: UploadFailures = { count: 0, firstError: undefined };

  // Phase 1+2: deletes carry no blob to upload — the commit itself drives the R2
  // delete (the client can't; files/sign mints only PUT/GET URLs). Metadata
  // first, then content. Unlike the puts below this is ONE call, not two:
  // commitBatched commits its input in array order across sequential chunks, so
  // the concatenation already IS the phase order — every entity's
  // metadata-delete commits no later than its content-delete. The one chunk that
  // can straddle the metadata/content boundary commits both in a single atomic
  // log write (the safe direction, never content-before-metadata), so splitting
  // it would only cost a redundant partial commit when the metadata count isn't
  // a multiple of COMMIT_BATCH.
  committed.push(
    ...(await commitBatched(deps, [
      ...deletes.filter((o) => !isContentPath(o.path)),
      ...deletes.filter((o) => isContentPath(o.path)),
    ])),
  );

  // Phase 3 then 4: drain ALL content puts (every chunk) before ANY metadata
  // put, so the content-before-metadata invariant holds across chunk boundaries
  // too.
  committed.push(
    ...(await pushPuts(
      deps,
      puts.filter((o) => isContentPath(o.path)),
      outcome,
      orphanedPaths,
      failures,
    )),
  );
  // A content upload that failed left its op queued — so the metadata phase
  // (which may reference that content) is HELD this cycle, or a puller could
  // land metadata whose content 404s: the exact breach the phase order exists to
  // prevent. Held wholesale because the engine is schema-blind — it can't tell
  // which metadata is safe. The held ops just stay queued; the next drain
  // retries both halves in order.
  if (failures.count === 0) {
    committed.push(
      ...(await pushPuts(
        deps,
        puts.filter((o) => !isContentPath(o.path)),
        outcome,
        orphanedPaths,
        failures,
      )),
    );
  }

  if (failures.count > 0) throw failures.firstError;
  return { committed, orphanedPaths };
}

// Drive a homogeneous put set (all content OR all metadata — the caller splits
// and orders them) through the sign → PUT → commit pipeline one chunk at a time,
// so each chunk's PUT URLs are minted immediately before that chunk's upload and
// the chunk commits before the next is signed. PUT_BATCH fits one sign and one
// commit call, so each stays a single round trip.
async function pushPuts(
  deps: SyncDeps,
  puts: PendingOpRecord[],
  outcome: SyncOutcome,
  orphanedPaths: string[],
  failures: UploadFailures,
): Promise<CommitResult[]> {
  const committed: CommitResult[] = [];
  for (const batch of chunk(puts, PUT_BATCH)) {
    const signed = await signPushable(deps, batch, outcome);
    if (signed === null) continue;
    const { orphaned, failed } = await uploadBlobs(deps, signed.ops, signed.urls, failures);
    // A put with nothing local left to send (see uploadBlobs) can never be
    // satisfied, so it is dropped from the queue rather than committed into a
    // guaranteed `no_object` that requeues it forever. Dropped BEFORE the commit, so
    // the op log never records an op for an object we didn't upload — and by
    // compare-and-delete, so a re-create that landed mid-cycle keeps its own op.
    let uploaded = signed.ops;
    if (orphaned.length > 0) {
      await clearDrainedOps(orphaned);
      orphanedPaths.push(...orphaned.map((o) => o.path));
      const dropped = new Set(orphaned.map((o) => o.path));
      uploaded = uploaded.filter((o) => !dropped.has(o.path));
    }
    // A transiently-failed PUT stays queued but is excluded from the commit: unlike
    // an unsigned path there is nothing gained by asking the server to HEAD an
    // object we know we didn't send — on a big failed chunk that's up to a thousand
    // doomed entries per cycle — and the failure is already surfaced through
    // `failures`.
    if (failed.length > 0) {
      const skipped = new Set(failed.map((o) => o.path));
      uploaded = uploaded.filter((o) => !skipped.has(o.path));
    }
    committed.push(...(await commitBatched(deps, uploaded)));
  }
  return committed;
}

// Sign one put chunk, surviving the server's quota gate instead of failing the
// cycle on it.
//
// Why this is not just `signPaths`: `files/sign` answers 403 `quota_exceeded`
// when the account is at its byte or object ceiling (bracemark-api
// lib/quota.ts). Letting that throw made the whole cycle fail, left the chunk
// queued, and re-failed it on every subsequent cycle — a PERMANENT wedge, and
// not confined to the offending blob: a chunk mixes list, tag, pin and settings
// puts, which were all stuck behind it. docs/iap.md promises an over-quota
// account "read-only-plus-delete, never data loss"; a wedged queue is not that.
//
// So a refusal is recorded on the outcome — with how many ops it cost, for the
// "12 changes aren't syncing" line (shared sync/status.ts) — and the cycle
// completes. There is no partial retry: being out of bytes or objects is not
// something a subset of the chunk fixes.
//
// This used to also handle `upgrade_required`, the free tier's link cap, which
// DID get a partial retry (drop the `links/` paths, push the rest). That whole
// branch is gone with the cap itself: it is enforced on the create surfaces now
// — including the iOS share sheet, which reads the
// count off its snapshot rather than the store it can't open
// (docs/share-sheet.md) — so an over-cap link never becomes a pending op.
//
// Blocked ops stay QUEUED, deliberately — they are the user's data, and they
// must upload the moment the account is back under its limits. The cost is one
// refused sign call per blocked chunk per cycle, bounded by the pending queue
// and the rate limiter, and it is what makes recovery automatic rather than
// something the user has to know to trigger.
//
// Any OTHER error still throws: an auth 403, a 5xx that outlived its retries,
// a network failure. Those are real cycle failures.
async function signPushable(
  deps: SyncDeps,
  batch: PendingOpRecord[],
  outcome: SyncOutcome,
): Promise<{ ops: PendingOpRecord[]; urls: Map<string, string> } | null> {
  try {
    return {
      ops: batch,
      urls: await signPaths(
        deps.api,
        'put',
        batch.map((o) => o.path),
      ),
    };
  } catch (e) {
    if (apiErrorCode(e) !== 'quota_exceeded') throw e;
    // Out of bytes/objects: the WHOLE chunk is refused, so that's the count.
    recordBlocked(outcome, batch.length);
    return null;
  }
}

// Commit a sequence of ops in input order, chunked under the commit cap —
// batches go out sequentially, so the caller's phase ordering is preserved
// across chunks. For each committed put, stamp R2's authoritative `updatedAt`
// onto the local record (a delete has no record left to stamp — the stamp is a
// no-op), then clear the ops it accepted. `failed` (only `no_object` today)
// is intentionally ignored: leaving the path queued is exactly the retry.
//
// The clear takes the OP ROWS this drain read, not the committed paths, so it
// removes only the writes it actually pushed (clearDrainedOps): an edit made during
// the push sits at the same path under a new `writeId` and must outlive this commit
// — its bytes are not the bytes that just went up. The restamp is unconditional
// even then: R2 does hold that path at `r.updatedAt` now, and the surviving op keeps
// its own older base, which local-wins reconcile never reads against it.
async function commitBatched(deps: SyncDeps, ops: PendingOpRecord[]): Promise<CommitResult[]> {
  const committed: CommitResult[] = [];
  for (const batch of chunk(ops, COMMIT_BATCH)) {
    const { results } = await deps.api.call(opsCommitEndpoint, {
      ops: batch.map((o) => ({ op: o.op, path: o.path })),
    });
    committed.push(...results);
    // All of a batch's restamps ride one transaction (stampItemUpdatedAts) rather
    // than a statement-per-result round trip; each row-gone stamp is still a no-op.
    await stampItemUpdatedAts(results);
    const accepted = new Set(results.map((r) => r.path));
    await clearDrainedOps(batch.filter((o) => accepted.has(o.path)));
  }
  return committed;
}

// Encrypt and PUT each op's local blob to its signed URL. This is where the
// platform's two crypto paths meet the two transports (sync/crypto.ts,
// sync/r2.ts): an entity blob encrypts in JS from the row's `data` bytes; a
// `files/` content blob encrypts path-to-path in the native layer from its
// on-disk plaintext into a temp ciphertext file, which uploads natively and is
// deleted either way.
//
// Sorts the ops it could not move into two buckets the caller treats differently,
// because the three skip shapes look alike and are not:
//
//  - `orphaned` — a missing record, an entity row without `data`, or a content row
//    whose plaintext file is gone. TERMINAL: a write stores the record and
//    enqueues its op in ONE transaction (mutations.ts), so an op without a payload
//    is never a write that hasn't landed yet; it is a record that went missing
//    underneath a queued op, and nothing will put it back. Retrying that forever
//    wedges the queue above zero, so the caller drops it. Since the guarded
//    deletes above stopped producing that state it should be unreachable, and
//    stays as the self-heal for a queue already wedged by it.
//  - `failed` — the PUT itself threw (network blip, an expired presigned URL on a
//    chunk that outlived the TTL). TRANSIENT: the op stays queued and re-signs
//    next drain; recorded on `failures` so the cycle still rejects after the
//    phases instead of reporting a false 'idle'. Caught per op, so one bad blob
//    no longer aborts its whole chunk before the chunk could commit anything —
//    which on a chunk too big for one TTL window was a deterministic livelock.
//  - an unsigned path (no URL came back): also transient — leaving it queued is
//    the retry, and the commit's `no_object` is the honest report.
async function uploadBlobs(
  deps: SyncDeps,
  ops: PendingOpRecord[],
  urls: Map<string, string>,
  failures: UploadFailures,
): Promise<{ orphaned: PendingOpRecord[]; failed: PendingOpRecord[] }> {
  const orphaned: PendingOpRecord[] = [];
  const failed: PendingOpRecord[] = [];
  const recordFailure = (op: PendingOpRecord, err: unknown): void => {
    failed.push(op);
    failures.count += 1;
    failures.firstError ??= err;
  };
  await mapLimit(ops, UPLOAD_CONCURRENCY, async (op) => {
    const rec = await getItem(op.path);
    if (!rec) {
      orphaned.push(op);
      return;
    }

    if (isContentPath(op.path)) {
      const plain = dataFileFor(op.path);
      if (!rec.hasDataFile || !plain.exists) {
        orphaned.push(op);
        return;
      }

      const url = urls.get(op.path);
      if (!url) return;

      const enc = newTempEncFile();
      try {
        await encryptFile(plain.uri, enc.uri, deps.encryptionKey);
        await putBlobFromFile(url, enc);
      } catch (err) {
        recordFailure(op, err);
      } finally {
        if (enc.exists) enc.delete();
      }
      return;
    }

    if (!rec.data) {
      orphaned.push(op);
      return;
    }

    const url = urls.get(op.path);
    if (!url) return;

    try {
      await putBlob(url, await encryptEntity(deps.encryptionKey, rec.data));
    } catch (err) {
      recordFailure(op, err);
    }
  });
  return { orphaned, failed };
}

// --- download / store / delete ----------------------------------------------

// Fetch, decrypt, and store a set of entries. Content (`files/`) records keep
// only their `updatedAt` — the blob stays lazy (and a CHANGED record drops any
// previously-materialized plaintext so a stale copy isn't served after an
// update: the re-stored row resets `hasDataFile` and the disk file goes with
// it). The index is pulled in chunks — each chunk signs its own GET URLs, then
// GETs + decrypts + stores at bounded concurrency — so the URL set never
// outgrows one batch.
async function storeDownloads(
  deps: SyncDeps,
  entries: Entry[],
  onProgress?: InitialSyncProgressFn,
): Promise<void> {
  if (entries.length === 0) return;

  // Skip paths whose local record is already current (same-or-newer server
  // stamp, with the decrypted bytes present for an index path). That makes a
  // re-run of an interrupted first sync RESUME instead of re-downloading
  // everything, makes a re-pulled echo of our own commit free, and keeps a
  // current content record's lazily-materialized file.
  const locals = await bulkGetItems(entries.map((e) => e.path));
  const stale = entries.filter((e, i) => {
    const local = locals[i];
    if (!local || local.updatedAt < e.updatedAt) return true;
    return !isContentPath(e.path) && !local.data;
  });

  const content = stale.filter((e) => isContentPath(e.path));
  const index = stale.filter((e) => !isContentPath(e.path));

  // toItemRecord is the single projector that derives the queryable `item*`
  // columns from the decrypted bytes (data/projection.ts) — the engine stays
  // schema-blind, it just routes every write through it so the projection can't
  // drift from `data`. A content record carries no bytes here, so it projects
  // none (only its `itemType`/`updatedAt`).
  //
  // Guarded (putItemsUnqueued): a path this device edited mid-cycle is absent from
  // the reconcile's pending snapshot, and landing the server copy on it would drop
  // the edit — see that helper. The stale plaintext then goes only for the rows
  // actually re-stored; a spared path's file is still its queued upload's payload.
  // Rows first, files after, the same fail-safe direction as applyDeletes.
  const stored = await putItemsUnqueued(
    deps.username,
    content.map((e) => toItemRecord(e.path, e.updatedAt)),
  );
  deleteDataFiles(stored);
  // The counter's denominator is `index` — what this pull is actually about to
  // fetch. Emitted once at zero before the first round trip so the gate can swap
  // its indeterminate state for a real bar right away rather than waiting for the
  // first blob to land. Nothing to fetch reports nothing at all: the gate reads
  // that as "still working" and stays indeterminate, which beats flashing a full
  // bar over a pull that is already over. Content records are excluded because
  // their blobs aren't downloaded here (only their rows are) — counting them would
  // inflate the total with work that costs no time.
  let done = 0;
  // Hoisted out of the batch loop below so the per-entry callback closes over a
  // `const` — a closure declared inside the loop that incremented `done` itself
  // reads to no-loop-func as a stale-capture bug, which it isn't here.
  const tick = () => onProgress?.(++done, index.length);
  if (index.length > 0) onProgress?.(done, index.length);

  // Index: sign → GET → decrypt → store one chunk at a time, so the presigned-URL
  // map never grows past a single batch (a large first sync holds ~1k URLs, not
  // all of them) and each URL's mint-to-GET latency stays well inside its 1-hour
  // TTL. Each record is stored the moment it's decrypted, so an interrupted run
  // resumes via the staleness skip above (fresh URLs for the shrinking
  // remainder) rather than restarting.
  for (const batch of chunk(index, SIGN_BATCH)) {
    const urls = await signPaths(
      deps.api,
      'get',
      batch.map((e) => e.path),
    );
    await mapLimit(batch, DOWNLOAD_CONCURRENCY, async (e) => {
      // `finally`, so the two skips below tick the counter too: an entry dropped
      // for a missing URL or a mid-pull 404 still leaves the pull with one fewer
      // thing to do, and a counter that ignored them would stop short of its
      // total and read as a hang on the one screen the user is watching. The
      // increment is safe unsynchronized — these callbacks interleave at await
      // points, they don't run in parallel.
      try {
        const url = urls.get(e.path);
        if (!url) return;

        const blob = await getBlob(url).catch((err: unknown) => {
          // Deleted between the op pull / listing and this GET: the delete op sits
          // past our window and reconciles next sync — skip it, don't fail the
          // cycle.
          if (err instanceof BlobRequestError && err.status === 404) return;
          throw err;
        });
        if (!blob) return;

        const data = await decryptEntity(deps.encryptionKey, blob);
        // Per record, not per batch: each arrives after its own GET, so this is the
        // largest group that can share one transaction with its queue check without
        // holding decrypted blobs in memory or losing the resume-where-interrupted
        // property the staleness skip above depends on.
        await putItemsUnqueued(deps.username, [toItemRecord(e.path, e.updatedAt, data)]);
      } finally {
        tick();
      }
    });
  }
}

// Drop the local records the reconcile judged deleted server-side — RE-TESTING the
// pending queue at apply time (item-store's deleteItemsUnqueued), because both
// callers filtered against the `pending` SNAPSHOT read at the top of the cycle and
// this device keeps writing through the round trips since. See that helper and
// docs/local-first-sync.md, _a sync cycle_, for what the unguarded version cost.
//
// Only the paths it actually deleted lose their disk files: a path spared by the
// guard still has a queued op, and that op's upload reads the plaintext file.
async function applyDeletes(username: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  // Rows (plus junction rows) first, disk files after — the fail-safe direction
  // (clear-data.ts): a crash in between leaves orphan files no row points at.
  const deleted = await deleteItemsUnqueued(username, paths);
  deleteDataFiles(deleted.filter(isContentPath));
}

// --- control-plane helpers --------------------------------------------------

// Page the full R2 listing (fallback + first sync). `pageToken` is R2's opaque
// cursor relayed straight back; loop until it comes back null. The listing is
// not a snapshot — safe here because every consumer compares `updatedAt`.
async function listAllFiles(api: ApiClient): Promise<Entry[]> {
  const out: Entry[] = [];
  let pageToken: string | undefined;
  do {
    const res = await api.call(filesListEndpoint, { pageToken, limit: FILES_PAGE });
    out.push(...res.files);
    pageToken = res.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

// Mint presigned URLs for a set of paths, batched under the contract cap,
// returned as a path→url map. `get` needs no quota so it batches freely; `put`
// is quota-checked server-side at issuance.
async function signPaths(
  api: ApiClient,
  op: SignOp,
  paths: string[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const batch of chunk(paths, SIGN_BATCH)) {
    const res = await api.call(filesSignEndpoint, { op, paths: batch });
    for (const u of res.urls) urls.set(u.path, u.url);
  }
  return urls;
}

// Route incremental vs. fallback from the op log's retained-range bounds (docs
// "the ops/list endpoint" routing table). A returning client always has a cursor
// here (incremental only runs post-first-sync), so an empty or out-of-range log
// means the log was wiped/compacted/reset beneath us — re-list R2.
function needsFallback(since: number, page: OpsListResponse): boolean {
  const { oldestUpdatedAt: oldest, newestUpdatedAt: newest } = page;
  if (newest === null) return true; // empty/wiped log under a returning client
  if (since > newest) return true; // cursor ahead — log was reset/restored
  if (oldest !== null && since < oldest) return true; // ops before the cursor were compacted
  return false; // oldest ≤ since ≤ newest — run the keyset query
}

// Keyset ordering on the compound cursor (updatedAt, path).
function isNewer(ts: number, path: string, curTs: number, curPath: string): boolean {
  return ts > curTs || (ts === curTs && path > curPath);
}

// Newest compound (updatedAt, path) across full-listing results — the cursor a
// download-authoritative flow (first sync, fallback) reconstructs. Taken over
// ALL entries, never just the last page: R2 lists in key order, not time order,
// so the newest can sit on any page. `(0, '')` for an empty account.
function newestCursor(...lists: Entry[][]): Entry {
  let updatedAt = 0;
  let path = '';
  for (const list of lists) {
    for (const e of list) {
      if (isNewer(e.updatedAt, e.path, updatedAt, path)) {
        updatedAt = e.updatedAt;
        path = e.path;
      }
    }
  }
  return { path, updatedAt };
}
