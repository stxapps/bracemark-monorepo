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
//  - The cycle lock is this runtime's own (withCycleLock), not a Web Lock. Web
//    needs one to keep cycles apart because every tab of an origin runs its own
//    copy of the engine over one store; here there is one runtime per store (the
//    Android share activity lives in the app's process, and the iOS share
//    extension writes an outbox file and never opens the database), so the
//    single-flight below already IS one cycle at a time for the account on this
//    device. The lock is there only so something that is not a cycle can hold
//    them off (holdSyncCycles). The first sync does not take it; the first-sync
//    flag keeps it and the cycles apart (runCycle).
//
// What does NOT diverge, and is restated here only because the source is
// duplicated: the cursor is a claim — "every op at or below this point has been
// applied" — so it moves only over ops a cycle listed, or to the log's high-water
// mark read before a listing (logWatermark). Never to a stamp this client merely
// holds.

import type { File } from 'expo-file-system';

import { decryptEntity, decryptFile, encryptEntity, encryptFile } from '@stxapps/expo-crypto';
import {
  type ApiClient,
  ApiError,
  apiErrorCode,
  BlobUnreadableError,
  chunk,
  createLimiter,
  createSignedFanOut,
  emptySyncOutcome,
  FILES_PREFIX,
  filesListEndpoint,
  filesSignEndpoint,
  type InitialSyncProgressFn,
  mapLimit,
  MAX_COMMIT_OPS,
  MAX_LIST_LIMIT,
  MAX_SIGN_PATHS,
  NO_TRACE,
  type OpEntry,
  opsCommitEndpoint,
  opsListEndpoint,
  type OpsListResponse,
  type ProgressFn,
  recordBlocked,
  sessionVerdictFromResponse,
  type SignedUrl,
  type SignOp,
  syncNamespace,
  type SyncOutcome,
  type SyncTrace,
  traceApi,
  untilAborted,
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
  getItemForOp,
  listItemUpdatedAts,
  markItemDataFileIfCurrent,
  putItemsUnqueued,
  stampItemUpdatedAts,
} from '../data/item-store';
import { holdLiveReads } from '../data/live-read-invalidation';
import { clearDrainedOps, listPendingOps, type PendingOpRecord } from '../data/pending-store';
import { toItemRecord } from '../data/projection';
import {
  advanceCursor,
  getSyncMeta,
  isFirstSyncDone,
  markFirstSyncDone,
  resetCursor,
} from '../data/sync-store';
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
// (anything ≤ the cap is valid; fewer round trips wins) — all but the content
// put chunk, CONTENT_PUT_BATCH below. A client-only knob, not contract.
const SIGN_BATCH = MAX_SIGN_PATHS;
const COMMIT_BATCH = MAX_COMMIT_OPS;
const OPS_PAGE = MAX_LIST_LIMIT;
const FILES_PAGE = MAX_LIST_LIMIT;

// Blob fan-out, split by SIZE rather than direction — web engine's constants,
// which carry the reading behind them: a small blob is latency-bound, each
// transfer one blob-route request whose time is nearly all the Worker waiting
// on R2, so the rate scales with the fan-out; and the 2026-10-19 staging floor
// held its p50 from 24 to 48 at once. Every index blob (links/tags/lists/
// settings) is small, and so is a `files/` blob up to LARGE_CONTENT_BYTES.
//
// A large `files/` blob is bound by bandwidth (the native path-to-path pipeline
// keeps memory flat, but a phone's radio saturates early), so it keeps the narrow
// fan-out, whether it is uploaded (uploadBlobs, through a gate inside the wide
// pass) or fetched (loadEntityContents, where the size is unknown until it
// arrives, so every content GET counts as large). Measured on web, not yet on a
// device — tune against a large first sync there.
const INDEX_CONCURRENCY = 48;
const FILE_CONCURRENCY = 8;

// Where a `files/` upload stops counting as small — web engine's, for the same
// arithmetic. Here the plaintext file's size decides it before anything is read,
// and the native upload has an idle deadline rather than a total one, so the
// bound is the radio's share per transfer, not a timer.
const LARGE_CONTENT_BYTES = 64 * 1024;

// One put-pipeline pass (pushPuts) signs, uploads, and commits a single chunk, so
// a chunk must fit BOTH the sign cap and the commit cap in one call each, and it
// keeps each signed PUT URL's mint-to-PUT latency inside its own chunk's
// upload window. The chunk is also the step the pending count moves in: its ops
// leave the queue only when it commits (commitBatched). So the size is per blob
// kind, the same split as the fan-out above.
//
// Index: the full cap — the commit cap (500) is the smaller today. KB-sized
// blobs at INDEX_CONCURRENCY drain it in seconds, well under the 5-min TTL, and a
// smaller chunk would only spend more of bracemark-api's `tight` rate limit (10
// calls per 10 s per user and per path, so files/sign and ops/commit each have a
// bucket and a chunk spends one call of each).
//
// Content: 100. At the full cap a `files/` chunk of MB-sized blobs ran for
// minutes on a phone uplink: minutes with the pending count frozen, and long
// enough for its tail to outlive the TTL. That expiry is absorbed per blob
// (uploadBlobs fails only its own op, the chunk commits what landed), but any
// failed content PUT holds the whole metadata phase until the next cycle. 100 is
// ~a minute at 1 MB a blob over 10 Mbps, gated FILE_CONCURRENCY wide. Small blobs
// go through at the full fan-out, and a chunk still spends one sign and one
// commit — web engine's comment has the rate-limit arithmetic.
const INDEX_PUT_BATCH = Math.min(SIGN_BATCH, COMMIT_BATCH);
const CONTENT_PUT_BATCH = 100;

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
  return { ...deps, api: withRetry(traceApi(deps.api, trace)) };
}

// The timing spans `measure:sync` reads (@stxapps/shared sync/trace.ts) — web
// engine's `trace`, which carries why it is module state. NO_TRACE unless
// installed; lib/sync-trace.ts installs a recorder in a bundle built with
// EXPO_PUBLIC_SYNC_TRACE=1.
let trace: SyncTrace = NO_TRACE;

export function installSyncTrace(next: SyncTrace | undefined): void {
  trace = next ?? NO_TRACE;
}

// A cycle that will write at least this many paths holds live reads
// (holdLiveReads, data/live-read-invalidation.ts) for its writes. Without the
// hold, every commit's restamp re-runs every live read on screen, and so does
// every record a pull stores. A pull stores each record the moment it decrypts,
// so the reads re-run back to back for as long as a large pull lasts. This is
// the same per-chunk cost the import's hold removes (docs/data-lifecycle.md,
// _readings — expo_).
//
// Not every cycle, because a hold delays the user's own edits too. Each edit
// kicks a cycle, so an edit made during an ordinary one would stay unrendered
// until the cycle ended or the next flush, up to HELD_FLUSH_MS. A cycle of a few paths costs a re-run or two, and
// holding it would buy nothing. 100 paths is around four rounds of
// INDEX_CONCURRENCY at 24, where a pull starts to outlast a re-run or two (two
// rounds at today's 48). It is a starting point, not a measured cut.
const BULK_CYCLE_PATHS = 100;

async function withBulkHold<T>(paths: number, run: () => Promise<T>): Promise<T> {
  const release = paths >= BULK_CYCLE_PATHS ? holdLiveReads() : undefined;
  try {
    return await run();
  } finally {
    release?.();
  }
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
// inventing one is the fake-progress-bar failure) — even though the GETs start
// on its first page — and the first tick arrives once the listing is done and
// the pull knows exactly how much it is fetching (startPull).
//
// ONE PULL AT A TIME PER ACCOUNT, AND ONLY WHILE THE FLAG IS UNSET. The cycle's
// guard (incrementalSyncOnce) keeps a cycle and the pull apart by reading the
// flag, and that holds only if two things are true of EVERY pull: it began with
// the flag unset, and it is the only one running. Neither was this function's
// doing. The provider reads the flag, then waits on the lifecycle lock for its
// claim, then calls here — and nothing stopped an effect that re-ran over a pull
// still in flight (the same account signed out and back in, a session paused and
// resumed) from starting a second beside it. Whichever finished first set the
// flag with the other still reconciling against its own, older listing, and from
// then a cycle was free to run beside that one: the overlap the guard is there
// to prevent, by another door.
//
// So a second caller joins the pull in flight, and a pull asked for once the
// flag is set does nothing. Those are the two things web's runInitialSync gets
// from holding the cycle lock and re-reading the flag inside it; with one
// runtime per store, a slot per account is the whole lock. A joiner's
// `onProgress` is fed from where it joined rather than dropped — it is usually
// the only gate still on screen, the first caller's effect having been replaced.
interface InflightPull {
  run: Promise<void>;
  listeners: Set<InitialSyncProgressFn>;
}

const inflightPulls = new Map<string, InflightPull>();

export function runInitialSync(deps: SyncDeps, onProgress?: InitialSyncProgressFn): Promise<void> {
  const key = deps.username;
  const inflight = inflightPulls.get(key);
  if (inflight) {
    if (onProgress) inflight.listeners.add(onProgress);
    return inflight.run;
  }
  const listeners = new Set<InitialSyncProgressFn>();
  if (onProgress) listeners.add(onProgress);
  const run = (async () => {
    try {
      await initialSyncOnce(deps, (done, total) => {
        for (const listener of listeners) listener(done, total);
      });
    } finally {
      inflightPulls.delete(key);
    }
  })();
  inflightPulls.set(key, { run, listeners });
  return run;
}

async function initialSyncOnce(deps: SyncDeps, onProgress: InitialSyncProgressFn): Promise<void> {
  // Inside the slot, so it is this pull's own reading and not its caller's: the
  // caller's is as old as its wait for the claim. The flag set means this
  // account's first sync has been done here already, by whoever held the slot
  // before — the store is complete up to its cursor, and listing the namespace
  // again would be a pull running where cycles are allowed.
  if (await isFirstSyncDone(deps.username)) return;
  deps = withRetryDeps(deps);
  await trace.span('cycle', () => initialPull(deps, onProgress), { kind: 'initial' });
}

async function initialPull(deps: SyncDeps, onProgress: InitialSyncProgressFn): Promise<void> {
  // The bookkeeping row is claimed before this runs, under the lifecycle lock
  // (sync-store.ts, claimIfStillSignedIn). The engine never claims it: a stale
  // cycle must not recreate the row a teardown dropped.
  // Read BEFORE the listing — it is the cursor this pull may claim once the
  // listing is stored, where the listing's own newest stamp is not.
  const watermark = await logWatermark(deps.api);
  // Each page is fetched as it is listed rather than after the whole listing
  // (web engine's initialPull). The bulk hold is taken once the listing reaches
  // BULK_CYCLE_PATHS, before that page is stored — where withBulkHold would have
  // taken it for the whole set, had the count been known up front.
  let release: (() => void) | undefined;
  try {
    const files = await trace.span('pull', async (note) => {
      let seen = 0;
      let listed: Entry[] = [];
      await feedPull(startPull(deps, onProgress), async (pull) => {
        listed = await listAllFiles(deps.api, async (page) => {
          seen += page.length;
          if (!release && seen >= BULK_CYCLE_PATHS) release = holdLiveReads();
          await pull.add(page);
        });
      });
      note({ entries: listed.length });
      return listed;
    });
    // The store is not always empty here: a pull that died partway (the app
    // killed, the connection dropped) left what it had stored, and this is its
    // retry, against a namespace that may have lost some of that since. Such a
    // path is in the store and not in the listing, and its delete op was
    // committed before the watermark above was read — at or below the cursor this
    // pull is about to claim, where no later pull returns it. So the listing is
    // reconciled in both directions, as the fallback does it (web engine, same
    // step). Nothing local on a fresh sign-in, so this costs one empty scan.
    await applyDeletes(deps.username, await localOnlyPaths(files));
  } finally {
    release?.();
  }
  await markFirstSyncDone(deps.username, watermark, '');
}

// The cursor a LISTING-built flow (first sync, fallback) may claim: the op log's
// newest stamp, read before the listing starts — web engine's logWatermark, which
// carries the full argument. In short: a paged R2 listing is not a snapshot, so
// its own newest stamp says nothing about an object written into a key range it
// had already passed, and an op stamped below that newest would be below the
// cursor for good. The log's high-water mark can make the claim: everything at or
// below it was committed (R2-first) before this read, so the listing reflects it,
// and the commit clamp stamps everything later above it. `(watermark, '')`
// re-lists the ops at exactly that millisecond, which the staleness skip absorbs;
// an empty log reads as 0 and claims nothing.
async function logWatermark(api: ApiClient): Promise<number> {
  const { newestUpdatedAt } = await api.call(opsListEndpoint, { since: 0, limit: 1 });
  return newestUpdatedAt ?? 0;
}

// Single-flight per account. Overlapping calls (the post-ready background pull,
// an edit-triggered requestSync, a retry) coalesce: a caller during a run shares
// the in-flight promise, and at most one trailing rerun picks up whatever changed
// after that run's snapshot. Serializing cycles keeps two drains from
// double-committing the same pending ops and keeps cursor writes ordered
// (advanceCursor's forward-only guard covers out-of-order stragglers). One
// runtime per store, so this is the whole of what web needs a cross-tab lock for
// between CYCLES; the cycle lock below is for holding them off (holdSyncCycles).
const inflightSyncs = new Map<string, Promise<SyncOutcome>>();
const rerunRequests = new Set<string>();

// The cycle lock — web's Web Lock of the same name, scoped to this runtime: per
// account, first come first served, taken by each cycle (incrementalSyncOnce) and
// by holdSyncCycles. The single-flight slot above already keeps cycles to one at
// a time; what the lock adds is a way for something that is NOT a cycle to keep
// the next one waiting. Each holder waits on the tail the one before it left; a
// waiter that gives up (its signal aborts) passes its turn straight on when it
// comes, so the queue never stalls on a run that will not happen.
const cycleLockTails = new Map<string, Promise<void>>();

async function withCycleLock<T>(
  username: string,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const before = cycleLockTails.get(username) ?? Promise.resolve();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const tail = before.then(() => released);
  cycleLockTails.set(username, tail);
  void tail.then(() => {
    if (cycleLockTails.get(username) === tail) cycleLockTails.delete(username);
  });
  const asked = trace.now();
  try {
    await untilAborted(before, signal);
  } catch (err) {
    release();
    throw err;
  }
  if (trace.enabled) trace.record({ name: 'cycle.lock', start: asked, end: trace.now() });
  try {
    return await run();
  } finally {
    release();
  }
}

// Run `work` with this account's sync cycles held off: a cycle already running
// is waited out first, and one asked for meanwhile waits until `work` settles —
// web engine's holdSyncCycles, which carries the reasoning (the delete-all flow:
// no cycle may push the queue past its server wipe, or pull beside it). A cycle
// asked for meanwhile still joins the single-flight slot as usual; its run just
// queues behind `work` for the lock.
//
// `onWait` fires only when there is something to wait for. `signal` aborts the
// WAIT and never the work: once the lock is held, `work` runs to the end.
export function holdSyncCycles<T>(
  username: string,
  work: () => Promise<T>,
  { onWait, signal }: { onWait?: () => void; signal?: AbortSignal } = {},
): Promise<T> {
  if (cycleLockTails.has(username)) onWait?.();
  return withCycleLock(username, work, signal);
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

// One cycle, under the cycle lock from its first read to its last write — so a
// holdSyncCycles caller is never overlapped by one.
function incrementalSyncOnce(deps: SyncDeps): Promise<SyncOutcome> {
  return withCycleLock(deps.username, () => runCycle(deps));
}

async function runCycle(deps: SyncDeps): Promise<SyncOutcome> {
  deps = withRetryDeps(deps);
  // Collected DOWN the call chain (the cycles → pushPending → pushPuts) and
  // returned UP, so the provider can tell a clean cycle from one the quota gate
  // clipped without either of them inspecting an error.
  const outcome = emptySyncOutcome();
  const meta = await getSyncMeta(deps.username);
  // NO CYCLE UNTIL THE FIRST SYNC IS DONE — it resolves having done nothing, and
  // whatever is queued waits for the cycle the provider kicks on reaching
  // 'ready'. A write CAN land before that (a share: the Android activity's save,
  // or an iOS outbox draft), and the pull spares it, because it is queued. What
  // it could not survive was the cycle its own kick started alongside the pull:
  // that cycle pushed the link and cleared its op, and the pull — still
  // reconciling against a listing taken before the push — then found a path that
  // was local-only and unqueued, and dropped it. The server kept the link; the
  // device lost it until a later cycle listed it back. That cycle also had no
  // cursor, so it routed to the fallback and fetched everything the pull had not
  // stored yet a second time, beside it.
  //
  // This is the step web's engine takes with its cycle lock, which
  // runInitialSync holds like any other cycle. The pull takes no lock here (one
  // runtime per store; the cycle lock is the cycles'), so the flag does it: a
  // pull only ever runs with the
  // flag unset, one at a time (runInitialSync holds both), and no cycle starts
  // until it is set, so the two never overlap.
  // Same predicate as isFirstSyncDone — an absent row is not-done.
  if (!meta || meta.firstSyncDoneAt <= 0) return outcome;
  // The cursor is the compound key (updatedAt, path); both halves go over the
  // wire as opsListEndpoint's `since` + `sincePath`. `since` is always sent
  // (even 0, for a seeded-but-empty new account) so the server's bounds can
  // route us; an empty `sincePath` is omitted (server reads it as the low
  // sentinel).
  const since = meta.syncCursorUpdatedAt;
  const sincePath = meta.syncCursorPath;
  const pending = await trace.span('queue.read', () => listPendingOps(deps.username));

  // Peek the first page: its retained-range bounds decide incremental vs.
  // fallback before we commit to paging the op log.
  const first = await deps.api.call(opsListEndpoint, {
    since,
    sincePath: sincePath || undefined,
    limit: OPS_PAGE,
  });

  if (needsFallback(since, first)) {
    // `first` was answered before the listing the fallback is about to take, so
    // its newest stamp is the high-water mark that listing will reflect.
    await trace.span(
      'cycle',
      () => fallbackCycle(deps, pending, outcome, first.newestUpdatedAt ?? 0),
      { kind: 'fallback', pending: pending.length },
    );
  } else {
    await trace.span(
      'cycle',
      () => incrementalCycle(deps, since, sincePath, first, pending, outcome),
      { kind: 'incremental', pending: pending.length },
    );
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

  const signed = (await signPaths(withRetry(deps.api), 'get', [path])).get(path);
  if (!signed) return undefined;

  const enc = newTempEncFile();
  try {
    try {
      await getBlobToFile(signed.url, enc, signed.authorization);
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
    await decryptFile(enc.uri, plain.uri, deps.encryptionKey, path);
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
  //
  // Web returns its fetched bytes on the same race and only skips the cache. That
  // isn't open here: the plaintext was decrypted into the path's one canonical
  // file, which the row no longer claims and a concurrent pull's deleteDataFiles
  // may remove under the caller. Serving it would need a second, caller-owned copy
  // for one render of a version that is already superseded. So `undefined` here
  // means "not now", as well as "gone" — the caller's next request gets the new
  // version.
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
// `files/sign` call per ~1000 paths instead of one per file) and fetched at
// FILE_CONCURRENCY, as web's is: these are MB-sized media, not index blobs.
// Already-materialized files are skipped (and don't count toward progress); a
// path that's unknown locally, 404s on GET (deleted on another device, the
// delete op not yet pulled) or does not open under its path (openFetchedFile)
// lands in `missingPaths` for the caller to report — never a thrown error. Any
// other failure rejects. The unreadable case is web's, for web's reason: one
// such blob used to fail the whole batch on every attempt. `bestEffort` is web's
// too, with web's reasoning (its engine.ts): a transport failure lands in
// `failedPaths` and the batch goes on, except a `session_revoked` verdict or a
// fenced write, which still reject.
export async function loadEntityContents(
  deps: SyncDeps,
  paths: string[],
  onProgress?: ProgressFn,
  options: { bestEffort?: boolean } = {},
): Promise<{ missingPaths: string[]; failedPaths: string[] }> {
  deps = withRetryDeps(deps);
  const tolerates = (err: unknown): boolean =>
    options.bestEffort === true &&
    !(err instanceof ApiError && sessionVerdictFromResponse(err.status, err.body) === 'revoked');

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
  const failedPaths: string[] = [];
  const batches = chunk(wanted, SIGN_BATCH);
  for (const [index, batch] of batches.entries()) {
    let urls: Map<string, SignedUrl>;
    try {
      urls = await signPaths(deps.api, 'get', batch);
    } catch (err) {
      if (!tolerates(err)) throw err;
      for (const path of batches.slice(index).flat()) {
        failedPaths.push(path);
        reportOne();
      }
      break;
    }
    await mapLimit(batch, FILE_CONCURRENCY, async (path) => {
      const signed = urls.get(path);
      let fetched = false;
      if (signed) {
        const enc = newTempEncFile();
        try {
          try {
            await getBlobToFile(signed.url, enc, signed.authorization);
            fetched = true;
          } catch (err: unknown) {
            if (!(err instanceof BlobRequestError && err.status === 404)) throw err;
          }
          if (fetched) {
            ensureDataFilesDir();
            // Same deterministic-overwrite + flag-last ordering as
            // loadEntityContent (see there).
            deleteDataFile(path);
            fetched = await openFetchedFile(deps, enc, path);
          }
        } catch (err) {
          if (!tolerates(err)) throw err;
          // A decrypt that threw part-way may have left plaintext behind, under a
          // row whose flag can predate it (a flagged row whose file had gone is
          // fetched again) — and the export includes any flagged row whose file
          // exists. Remove it, so a failed path is no file at all.
          deleteDataFile(path);
          failedPaths.push(path);
          reportOne();
          return;
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
  return { missingPaths, failedPaths };
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
  await withBulkHold(pending.length + downloads.length + localDeletes.length, async () => {
    const orphanedPaths = await pushPending(deps, pending, outcome);
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
  });

  // 5. Advance the cursor over what this cycle LISTED — and not over its own
  // commits, which is what this step used to fold in. The commit clamp stamps a
  // commit above everything already in the log, including an op another client
  // committed after the last list page above; a cursor at our own stamp claims a
  // range nobody read, and the keyset pull never returns what is below it — a link
  // saved on the laptop that never reaches this phone, with the cycle complete and
  // nothing to retry. The next cycle lists our commits back instead, and that echo
  // costs an op row each and no transfer: the commit restamped every record to the
  // stamp its op carries, so storeDownloads' staleness skip passes over it, and an
  // echoed delete finds no record to remove. (Web engine, same step.)
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
//
// `watermark` is the op log's newest stamp as the routing peek saw it — read
// before the listing below, which is what makes it the cursor to end on
// (logWatermark).
async function fallbackCycle(
  deps: SyncDeps,
  pending: PendingOpRecord[],
  outcome: SyncOutcome,
  watermark: number,
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
  await withBulkHold(pending.length + downloads.length + localDeletes.length, async () => {
    const orphanedPaths = await pushPending(deps, pending, outcome);
    // Same heal as the incremental cycle: a dropped op's path was excluded from the
    // download set above — re-add the listed server copy so it comes back.
    for (const path of orphanedPaths) {
      const updatedAt = serverFiles.get(path);
      if (updatedAt !== undefined) downloads.push({ path, updatedAt });
    }
    await storeDownloads(deps, downloads);
    await applyDeletes(deps.username, localDeletes);
  });

  // Cursor = the log's high-water mark as it stood BEFORE the listing — not the
  // newest of the listing and our own commits, which could sit above an op nobody
  // had read: the listing is not a snapshot, and our commits are stamped past
  // whatever another client committed while we pushed. Everything at or below the
  // watermark is in the listing just reconciled; everything since, our own commits
  // included, is above it and comes back on the next pull. resetCursor, not
  // advanceCursor, because this still has to LOWER a cursor that is ahead of a
  // reset log — and an empty log leaves `(0, '')`, which routes the next cycle
  // here again rather than claiming anything.
  await resetCursor(deps.username, watermark, '');
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
// paths of ops the self-heal dropped (uploadBlobs) so the caller can re-add their
// server copies to its download set — and nothing about what it committed: each
// commit's stamp belongs on the record it names (commitBatched), never on the
// cursor, which moves only over ops a cycle listed. Removes each committed op
// from the queue; a `no_object` failure is left queued to re-PUT next drain.
//
// Runs in the global phase order [delete-metadata, delete-content, put-content,
// put-metadata] — the mirror pair of the multi-file-consistency rules (docs
// "multi-file consistency"): a create writes content before the metadata that
// references it; a delete removes that metadata before the content it
// referenced. So no crash or partial push ever leaves metadata pointing at a
// missing content file. Crucially each PHASE commits durably before the next,
// and each CHUNK within the put phases signs + uploads + commits as one unit
// (pushPuts) — so a signed PUT URL never outlives its own chunk's upload
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
): Promise<string[]> {
  if (ops.length === 0) return [];
  return trace.span('push', () => pushPhases(deps, ops, outcome), {
    puts: ops.filter((o) => o.op === 'put').length,
    deletes: ops.filter((o) => o.op === 'delete').length,
  });
}

async function pushPhases(
  deps: SyncDeps,
  ops: PendingOpRecord[],
  outcome: SyncOutcome,
): Promise<string[]> {
  const puts = ops.filter((o) => o.op === 'put');
  const deletes = ops.filter((o) => o.op === 'delete');
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
  await commitBatched(deps, [
    ...deletes.filter((o) => !isContentPath(o.path)),
    ...deletes.filter((o) => isContentPath(o.path)),
  ]);

  // Phase 3 then 4: drain ALL content puts (every chunk, every commit) before
  // ANY metadata put, so the content-before-metadata invariant holds across chunk
  // boundaries too. Each phase uploads at its own blob kind's chunk size; both at
  // the full fan-out, with large content gated narrower inside it (uploadBlobs).
  const metadataPuts = puts.filter((o) => !isContentPath(o.path));
  const contentRefused = await pushPuts(
    deps,
    puts.filter((o) => isContentPath(o.path)),
    CONTENT_PUT_BATCH,
    INDEX_CONCURRENCY,
    outcome,
    orphanedPaths,
    failures,
  );
  // A content upload that failed left its op queued — so the metadata phase
  // (which may reference that content) is HELD this cycle, or a puller could
  // land metadata whose content 404s: the exact breach the phase order exists to
  // prevent. Held wholesale because the engine is schema-blind — it can't tell
  // which metadata is safe. The held ops just stay queued; the next drain
  // retries both halves in order.
  //
  // Content the quota gate refused is held behind for the same reason. Asking
  // the gate again would usually be refused too — it reads usage, and usage only
  // grew — but not always: a delete committed by another device, or a purchase
  // that raised the ceiling, can land between the two sign calls, and the
  // metadata phase would then go up without the content it names. The held ops
  // count as blocked: they are stuck behind the refusal, and the next cycle that
  // fits pushes both halves.
  if (contentRefused) {
    recordBlocked(outcome, metadataPuts.length);
  } else if (failures.count === 0) {
    await pushPuts(
      deps,
      metadataPuts,
      INDEX_PUT_BATCH,
      INDEX_CONCURRENCY,
      outcome,
      orphanedPaths,
      failures,
    );
  }

  if (failures.count > 0) throw failures.firstError;
  return orphanedPaths;
}

// Drive a homogeneous put set (all content OR all metadata — the caller splits
// and orders them) through the sign → PUT → commit pipeline one chunk at a time,
// so each chunk's PUT URLs are minted immediately before that chunk's upload.
// `batchSize` (≤ both caps) keeps the sign and the commit a single round trip
// each; it and `concurrency` are the set's kind's. Resolves true when the quota
// gate refused the set — the caller holds the metadata phase on it, as it does on
// a failed upload.
//
// A chunk's commit overlaps the next chunk's sign and upload, one commit in
// flight at most, so commits stay in order and a failed one stops the set; the
// set resolves only once its last commit has, and a throw waits for the one in
// flight. Web engine's pushPuts carries the full account, including what it
// costs the quota gate's view.
async function pushPuts(
  deps: SyncDeps,
  puts: PendingOpRecord[],
  batchSize: number,
  concurrency: number,
  outcome: SyncOutcome,
  orphanedPaths: string[],
  failures: UploadFailures,
): Promise<boolean> {
  let committing: Promise<void> = Promise.resolve();
  try {
    return await pushChunks();
  } catch (err) {
    await committing.catch(() => undefined);
    throw err;
  }

  async function pushChunks(): Promise<boolean> {
    let unsigned = puts.length;
    // Homogeneous by contract (the caller splits the kinds), so the first op names it.
    const kind = puts.length > 0 && isContentPath(puts[0].path) ? 'content' : 'index';
    for (const batch of chunk(puts, batchSize)) {
      const chunkStart = trace.now();
      const signed = await signPushable(deps, batch, outcome);
      unsigned -= batch.length;
      // The quota gate refuses on the account's usage, never on which paths a
      // chunk holds, so every later chunk of this set would be refused too: record
      // them without asking. One refused sign call per put phase, not per chunk —
      // which CONTENT_PUT_BATCH would otherwise multiply against the rate limit.
      if (signed === null) {
        await committing;
        recordBlocked(outcome, unsigned);
        return true;
      }
      const uploaded = await uploadChunk(signed);
      // One commit in flight at most: this chunk's starts once the last one's has
      // landed, so the queue is never more than one chunk behind the uploads, and a
      // failed commit stops the set once the chunk already uploading is done.
      await committing;
      committing = commitChunk(uploaded, { kind, ops: batch.length }, chunkStart);
      // Observed here so a failure is never unhandled while the next chunk signs
      // and uploads; the next `await committing` still sees the rejection.
      void committing.catch(() => undefined);
    }
    await committing;
    return false;
  }

  // Commit one uploaded chunk, and time the chunk from its sign to its commit.
  async function commitChunk(
    uploaded: PendingOpRecord[],
    attrs: { kind: string; ops: number },
    start: number,
  ): Promise<void> {
    await commitBatched(deps, uploaded);
    if (trace.enabled) trace.record({ name: 'push.chunk', start, end: trace.now(), attrs });
  }

  // Upload one signed chunk and return the ops its commit should carry.
  async function uploadChunk(signed: {
    ops: PendingOpRecord[];
    urls: Map<string, SignedUrl>;
  }): Promise<PendingOpRecord[]> {
    const { orphaned, failed, superseded } = await trace.span(
      'upload',
      () => uploadBlobs(deps, signed.ops, signed.urls, concurrency, failures),
      { ops: signed.ops.length, concurrency },
    );
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
    // object we know we didn't send — on a big failed chunk that's up to a chunk's
    // worth (100 or 500) of doomed entries per cycle — and the failure is already
    // surfaced through `failures`.
    if (failed.length > 0) {
      const skipped = new Set(failed.map((o) => o.path));
      uploaded = uploaded.filter((o) => !skipped.has(o.path));
    }
    // A superseded op sent nothing either (uploadBlobs), and is no failure: the
    // write that replaced it sits queued under its own `writeId` and asked for the
    // cycle that will carry it. Kept out of the commit for the reason a failed one
    // is — the server would HEAD an object this cycle did not send, and where an
    // earlier version exists it would log an op for bytes that are not these.
    if (superseded.length > 0) {
      const skipped = new Set(superseded.map((o) => o.path));
      uploaded = uploaded.filter((o) => !skipped.has(o.path));
    }
    return uploaded;
  }
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
// refused sign call per cycle (pushPuts stops a phase at its first refusal, and
// a refused content phase holds the metadata phase unasked), and it is what
// makes recovery automatic rather than something the user has to know to
// trigger.
//
// Any OTHER error still throws: an auth 403, a 5xx that outlived its retries,
// a network failure. Those are real cycle failures.
async function signPushable(
  deps: SyncDeps,
  batch: PendingOpRecord[],
  outcome: SyncOutcome,
): Promise<{ ops: PendingOpRecord[]; urls: Map<string, SignedUrl> } | null> {
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
async function commitBatched(deps: SyncDeps, ops: PendingOpRecord[]): Promise<void> {
  for (const batch of chunk(ops, COMMIT_BATCH)) {
    await trace.span('commit', () => commitOne(deps, batch), { ops: batch.length });
  }
}

async function commitOne(deps: SyncDeps, batch: PendingOpRecord[]): Promise<void> {
  const { results } = await deps.api.call(opsCommitEndpoint, {
    ops: batch.map((o) => ({ op: o.op, path: o.path })),
  });
  // All of a batch's restamps ride one transaction (stampItemUpdatedAts) rather
  // than a statement-per-result round trip; each row-gone stamp is still a no-op.
  await trace.span('commit.restamp', () => stampItemUpdatedAts(deps.username, results));
  const accepted = new Set(results.map((r) => r.path));
  await trace.span('commit.clear', () =>
    clearDrainedOps(batch.filter((o) => accepted.has(o.path))),
  );
}

// Encrypt and PUT each op's local blob to its signed URL. This is where the
// platform's two crypto paths meet the two transports (sync/crypto.ts,
// sync/r2.ts): an entity blob encrypts in JS from the row's `data` bytes; a
// `files/` content blob encrypts path-to-path in the native layer from its
// on-disk plaintext into a temp ciphertext file, which uploads natively and is
// deleted either way.
//
// THE WRITE THE OP STANDS FOR, or nothing (web engine's uploadBlobs carries the
// full account). An op holds no payload; its row is read here, when its own
// upload starts, round trips after the cycle read the queue. So the row is read
// together with the queue row at its path, in one transaction (item-store's
// getItemForOp), and sent only if that row is still the op this cycle holds — a
// write replaces the `writeId` in the transaction that stores its bytes. Without
// it a metadata op queued before the cycle uploaded a record rewritten since,
// naming a `files/` blob this cycle holds no op for: device extraction's image
// landing after its title, or a custom image set on a link with an edit already
// queued. The phase order held over the ops and broke over the bytes.
//
// Sorts the ops it could not move into three buckets the caller treats
// differently, because the four skip shapes look alike and are not:
//
//  - `superseded` — the queue row at this path is no longer this op: a later write
//    replaced it (a re-edit, or a delete), or it is gone. NOT a failure and nothing
//    to retry here: the later write is queued under its own `writeId`, and the
//    cycle that reads THAT op pushes it, with the content it names, in phase
//    order. Checked first, because a path deleted since the queue was read has no
//    row either, and it is a newer intent, not an orphan to heal.
//  - `orphaned` — the queue row IS still this op, and there is a missing record,
//    an entity row without `data`, or a content row whose plaintext file is gone.
//    TERMINAL: a write stores the record and enqueues its op in ONE transaction
//    (mutations.ts), so an op without a payload is never a write that hasn't
//    landed yet; it is a record that went missing underneath a queued op, and
//    nothing will put it back. Retrying that forever wedges the queue above zero,
//    so the caller drops it. Since the guarded deletes above stopped producing
//    that state it should be unreachable, and stays as the self-heal for a queue
//    already wedged by it.
//  - `failed` — the PUT itself threw (network blip, an expired signed URL on a
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
  urls: Map<string, SignedUrl>,
  concurrency: number,
  failures: UploadFailures,
): Promise<{
  orphaned: PendingOpRecord[];
  failed: PendingOpRecord[];
  superseded: PendingOpRecord[];
}> {
  const orphaned: PendingOpRecord[] = [];
  const failed: PendingOpRecord[] = [];
  const superseded: PendingOpRecord[] = [];
  const recordFailure = (op: PendingOpRecord, err: unknown): void => {
    failed.push(op);
    failures.count += 1;
    failures.firstError ??= err;
  };
  const largeGate = createLimiter(FILE_CONCURRENCY);

  // The op's row if its queue row is still this op, sorted into its bucket if not.
  const readForUpload = async (op: PendingOpRecord) => {
    const { row: rec, stillQueued } = await trace.span('blob.read', () => getItemForOp(op));
    if (!stillQueued) {
      superseded.push(op);
      return undefined;
    }
    if (!rec) {
      orphaned.push(op);
      return undefined;
    }
    return rec;
  };

  // A content op's plaintext file, or nothing when there is none to send.
  const contentFileFor = (op: PendingOpRecord, rec: { hasDataFile: boolean | null }) => {
    const plain = dataFileFor(op.path);
    if (!rec.hasDataFile || !plain.exists) {
      orphaned.push(op);
      return undefined;
    }
    return plain;
  };

  const sendContent = async (op: PendingOpRecord, plain: File, signed: SignedUrl) => {
    const enc = newTempEncFile();
    try {
      await trace.span('blob.encrypt', () =>
        encryptFile(plain.uri, enc.uri, deps.encryptionKey, op.path),
      );
      await trace.span('blob.put', () => putBlobFromFile(signed.url, enc, signed.authorization), {
        bytes: enc.size,
        ns: syncNamespace(op.path),
      });
    } catch (err) {
      recordFailure(op, err);
    } finally {
      if (enc.exists) enc.delete();
    }
  };

  await mapLimit(ops, concurrency, async (op) => {
    const rec = await readForUpload(op);
    if (!rec) return;

    if (isContentPath(op.path)) {
      const plain = contentFileFor(op, rec);
      if (!plain) return;

      const signed = urls.get(op.path);
      if (!signed) return;

      // A large blob waits for one of FILE_CONCURRENCY slots inside the pass's own
      // fan-out, and takes the queue test again once it has one: the wait can be
      // long, and a write landing in it replaces the file this op would send.
      if (plain.size > LARGE_CONTENT_BYTES) {
        await largeGate(async () => {
          const held = await readForUpload(op);
          const file = held && contentFileFor(op, held);
          if (file) await sendContent(op, file, signed);
        });
        return;
      }
      await sendContent(op, plain, signed);
      return;
    }

    if (!rec.data) {
      orphaned.push(op);
      return;
    }

    const signed = urls.get(op.path);
    if (!signed) return;

    const data = rec.data;
    try {
      const sealed = await trace.span('blob.encrypt', () =>
        encryptEntity(deps.encryptionKey, data, op.path),
      );
      await trace.span('blob.put', () => putBlob(signed.url, sealed, signed.authorization), {
        bytes: sealed.byteLength,
        ns: syncNamespace(op.path),
      });
    } catch (err) {
      recordFailure(op, err);
    }
  });
  return { orphaned, failed, superseded };
}

// --- download / store / delete ----------------------------------------------

// Fetch, decrypt, and store a set of entries. Content (`files/`) records keep
// only their `updatedAt` — the blob stays lazy (and a CHANGED record drops any
// previously-materialized plaintext so a stale copy isn't served after an
// update: the re-stored row resets `hasDataFile` and the disk file goes with
// it). The index is fetched by one fan-out that signs its GET URLs a batch at a
// time, so the URL set never outgrows about one batch (startPull).
async function storeDownloads(
  deps: SyncDeps,
  entries: Entry[],
  onProgress?: InitialSyncProgressFn,
): Promise<void> {
  if (entries.length === 0) return;
  await trace.span(
    'pull',
    () =>
      feedPull(startPull(deps, onProgress), async (pull) => {
        await pull.add(entries);
      }),
    { entries: entries.length },
  );
}

// A pull in progress — web engine's PullRun, which carries the design: entries
// go in as they are known (a cycle's whole set, or a first sync's listing a page
// at a time) and every index GET rides one fan-out.
interface PullRun {
  // Sort a set of entries and start fetching what it needs. Resolves once they
  // are queued, not fetched.
  add(entries: Entry[]): Promise<void>;
  // Nothing more is coming: resolves once every queued GET has been stored.
  finish(): Promise<void>;
  // The feed failed: stop starting GETs.
  abandon(reason: unknown): void;
}

// Run `feed` against a pull and finish it — or, when the feed throws, abandon the
// fan-out so it starts nothing more, and rethrow.
async function feedPull(pull: PullRun, feed: (pull: PullRun) => Promise<void>): Promise<void> {
  try {
    await feed(pull);
  } catch (err) {
    pull.abandon(err);
    throw err;
  }
  await pull.finish();
}

function startPull(deps: SyncDeps, onProgress?: InitialSyncProgressFn): PullRun {
  // The counter's denominator is every index entry this pull is about to fetch,
  // reported only once it is final — at `finish` — because a first sync adds a
  // page at a time and a total that grew under the bar would be the
  // fake-progress failure (web engine's startPull has the rest). Nothing to fetch
  // reports nothing at all, and content records are not counted: their blobs
  // aren't downloaded here, only their rows.
  let done = 0;
  let total = 0;
  let totalKnown = false;
  const report = (): void => {
    if (totalKnown && total > 0) onProgress?.(done, total);
  };
  let downloadStart: number | undefined;

  // `finally`, so the two skips below tick the counter too: an entry dropped
  // for a missing URL or a mid-pull 404 still leaves the pull with one fewer
  // thing to do, and a counter that ignored them would stop short of its
  // total and read as a hang on the one screen the user is watching. The
  // increment is safe unsynchronized — these callbacks interleave at await
  // points, they don't run in parallel.
  const pullOne = async (e: Entry, signed: SignedUrl | undefined): Promise<void> => {
    try {
      if (!signed) return;

      const blob = await trace.span(
        'blob.get',
        (note) =>
          getBlob(signed.url, signed.authorization).then(
            (bytes) => {
              note({ bytes: bytes.byteLength });
              return bytes;
            },
            (err: unknown) => {
              // Deleted between the op pull / listing and this GET: the delete op
              // sits past our window and reconciles next sync — skip it, don't fail
              // the cycle.
              if (err instanceof BlobRequestError && err.status === 404) return undefined;
              throw err;
            },
          ),
        { ns: syncNamespace(e.path) },
      );
      if (!blob) return;

      const data = await trace.span('blob.decrypt', () => openPulled(deps, blob, e.path));
      if (!data) return;
      // Per record, not per batch: each arrives after its own GET, so this is the
      // largest group that can share one transaction with its queue check without
      // holding decrypted blobs in memory or losing the resume-where-interrupted
      // property the staleness skip in `add` depends on.
      await trace.span('blob.store', () =>
        putItemsUnqueued(deps.username, [toItemRecord(e.path, e.updatedAt, data)]),
      );
    } finally {
      done += 1;
      report();
    }
  };

  // Index: sign → GET → decrypt → store, one signed batch ahead of the GETs, so
  // the signed-URL set never grows past about one batch and each URL's
  // mint-to-GET latency stays well inside its 1-hour TTL. Each record is stored
  // the moment it's decrypted, so an interrupted run resumes via the staleness
  // skip in `add` (fresh URLs for the shrinking remainder) rather than restarting.
  const fanOut = createSignedFanOut<Entry, SignedUrl>({
    concurrency: INDEX_CONCURRENCY,
    signBatch: SIGN_BATCH,
    sign: (paths) => signPaths(deps.api, 'get', paths),
    run: pullOne,
  });

  return {
    async add(entries) {
      if (entries.length === 0) return;
      // Skip paths whose local record is already current (same-or-newer server
      // stamp, with the decrypted bytes present for an index path). That makes a
      // re-run of an interrupted first sync RESUME instead of re-downloading
      // everything, keeps a current content record's lazily-materialized file, and
      // makes the echo of our own commit free — on every cycle now, since the cursor
      // no longer skips our commits and each one is listed back once. (Web settles
      // content echoes off an index first, to avoid reading cached blobs; a content
      // row here carries no bytes — they are on disk — so one read serves both.)
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
      // Guarded (putItemsUnqueued): a path this device edited mid-cycle is absent
      // from the reconcile's pending snapshot, and landing the server copy on it
      // would drop the edit — see that helper. The stale plaintext then goes only
      // for the rows actually re-stored; a spared path's file is still its queued
      // upload's payload. Rows first, files after, the same fail-safe direction as
      // applyDeletes.
      const stored = await putItemsUnqueued(
        deps.username,
        content.map((e) => toItemRecord(e.path, e.updatedAt)),
      );
      deleteDataFiles(stored);

      if (index.length === 0) return;
      total += index.length;
      downloadStart ??= trace.now();
      fanOut.add(index);
    },
    async finish() {
      totalKnown = true;
      report();
      let failed: string | undefined;
      try {
        await fanOut.close();
      } catch (err) {
        failed = err instanceof Error ? err.name : 'Error';
        throw err;
      } finally {
        if (trace.enabled && downloadStart !== undefined) {
          trace.record({
            name: 'download',
            start: downloadStart,
            end: trace.now(),
            attrs: { entries: total, concurrency: INDEX_CONCURRENCY },
            ...(failed ? { failed } : {}),
          });
        }
      }
    },
    abandon(reason) {
      fanOut.abandon(reason);
    },
  };
}

// Decrypt one pulled blob, or skip it when it does not open under its path
// (BlobUnreadableError) — web engine's openPulled, which carries the reasoning:
// one such path must not fail every cycle for every path. Skipped like a 404:
// nothing stored, the cursor moves on, a local copy stays. Anything else, an
// unknown format version above all, still throws.
async function openPulled(
  deps: SyncDeps,
  blob: Uint8Array,
  path: string,
): Promise<Uint8Array | undefined> {
  try {
    return await decryptEntity(deps.encryptionKey, blob, path);
  } catch (err) {
    if (!(err instanceof BlobUnreadableError)) throw err;
    console.warn(`sync: skipped ${path}, which does not open under its path`);
    return undefined;
  }
}

// openPulled for a fetched `files/` ciphertext, which decrypts path-to-path into
// the path's plaintext location: true once it is there, false when the blob does
// not open under its path (BlobUnreadableError — expo-crypto's decryptFile maps
// the native tag and truncation failures onto it). A failed decrypt leaves no
// output behind, so false needs no cleanup. Anything else still throws.
async function openFetchedFile(deps: SyncDeps, enc: File, path: string): Promise<boolean> {
  try {
    await decryptFile(enc.uri, dataFileFor(path).uri, deps.encryptionKey, path);
    return true;
  } catch (err) {
    if (!(err instanceof BlobUnreadableError)) throw err;
    console.warn(`sync: skipped ${path}, which does not open under its path`);
    return false;
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
  await trace.span('deletes.apply', () => applyDeletesNow(username, paths), {
    paths: paths.length,
  });
}

async function applyDeletesNow(username: string, paths: string[]): Promise<void> {
  // Rows (plus junction rows) first, disk files after — the fail-safe direction
  // (clear-data.ts): a crash in between leaves orphan files no row points at.
  const deleted = await deleteItemsUnqueued(username, paths);
  deleteDataFiles(deleted.filter(isContentPath));
}

// The local paths a full listing does not show: what a first sync's retry has to
// drop, by the fallback's "local only" row. The caller hands these to
// applyDeletes, which spares any path with an op queued.
async function localOnlyPaths(files: Entry[]): Promise<string[]> {
  const listed = new Set(files.map((f) => f.path));
  const local = await listItemUpdatedAts();
  return [...local.keys()].filter((path) => !listed.has(path));
}

// --- control-plane helpers --------------------------------------------------

// Page the full R2 listing (fallback + first sync). `pageToken` is R2's opaque
// cursor relayed straight back; loop until it comes back null. The listing is
// not a snapshot: pages span concurrent writes, and an object written into a key
// range already passed is simply absent. That is safe for what gets DOWNLOADED
// (every consumer compares `updatedAt`) and is exactly why the listing never
// supplies the CURSOR — both callers end on the log's high-water mark instead
// (logWatermark).
// `onPage` sees each page before the next is asked for.
async function listAllFiles(
  api: ApiClient,
  onPage?: (page: Entry[]) => Promise<void>,
): Promise<Entry[]> {
  const out: Entry[] = [];
  let pageToken: string | undefined;
  do {
    const res = await api.call(filesListEndpoint, { pageToken, limit: FILES_PAGE });
    out.push(...res.files);
    await onPage?.(res.files);
    pageToken = res.nextPageToken ?? undefined;
  } while (pageToken);
  return out;
}

// Mint signed URLs for a set of paths, batched under the contract cap, returned
// as a path→signed-URL map. `get` needs no quota so it batches freely; `put` is
// quota-checked server-side at issuance.
//
// Always asks for the api's blob route (`via: 'api'`), as web-react's engine
// does and for the same reason: R2's S3 endpoint is HTTP/1.1, and URLSession and
// OkHttp each cap a host at a handful of connections (docs/local-first-sync.md,
// _the blob route_). The answer is self-describing, so an api that predates the
// field answers with presigns and the sync still works.
async function signPaths(
  api: ApiClient,
  op: SignOp,
  paths: string[],
): Promise<Map<string, SignedUrl>> {
  const urls = new Map<string, SignedUrl>();
  for (const batch of chunk(paths, SIGN_BATCH)) {
    const res = await api.call(filesSignEndpoint, { op, paths: batch, via: 'api' });
    for (const u of res.urls) urls.set(u.path, u);
  }
  return urls;
}

// Route incremental vs. fallback from the op log's retained-range bounds (docs
// "the ops/list endpoint" routing table). A returning client always has a cursor
// here (incremental only runs post-first-sync — incrementalSyncOnce returns
// before this when the flag is unset), so an empty or out-of-range log
// means the log was wiped/compacted/reset beneath us — re-list R2.
function needsFallback(since: number, page: OpsListResponse): boolean {
  const { oldestUpdatedAt: oldest, newestUpdatedAt: newest } = page;
  if (newest === null) return true; // empty/wiped log under a returning client
  if (since > newest) return true; // cursor ahead — log was reset/restored
  if (oldest !== null && since < oldest) return true; // ops before the cursor were compacted
  return false; // oldest ≤ since ≤ newest — run the keyset query
}
