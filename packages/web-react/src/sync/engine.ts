'use client';

// Hand-rolled sync engine — layer 2 in docs/local-first-sync.md. Runs at the
// app/background level, NOT in React (no hooks): it drives the four-endpoint
// control plane through the shared contract client (`api.call`, which is
// `callEndpoint` bound to bracemark-api's baseUrl with the bearer token attached) and
// moves blob bytes to/from R2 over the URLs `files/sign` mints (the api's blob
// route, or a presign of R2 from an api that predates it), doing the crypto boundary
// (encrypt before PUT / decrypt after GET) with @stxapps/web-crypto. Decrypted
// results land in the Dexie store (db.ts), which the UI observes reactively.
//
// R2 is the source of truth; the op log is a disposable accelerator (the doc's
// central invariant). So every flow can fall back to listing R2 and lose nothing
// but speed, and the cursor is R2's `LastModified` — the compound key
// `(updatedAt, path)` — never the op log's internal `seq`.
//
// THE CURSOR IS A CLAIM, and every write of it below is held to it: "this client
// has applied every op at or below this point." So it only ever moves over ops a
// cycle LISTED (incrementalCycle), or to the log's high-water mark read before a
// listing that then reflects everything up to it (logWatermark). It is never set
// from a stamp this client merely holds — its own commits, or the newest object a
// listing happened to show — because another client's op can sit below either.

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
  isTransientBlobStatus,
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
  retryTransientBlobTransfer,
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
import { decryptEntity, encryptEntity } from '@stxapps/web-crypto';

import { db, type ItemRecord, type PendingOpRecord } from '../data/db';
import { clearDrainedOps, listPendingOps } from '../data/pending-store';
import { toItemRecord } from '../data/projection';
import {
  advanceCursor,
  assertAccountStillOwnsStore,
  getSyncMeta,
  isFirstSyncDone,
  markFirstSyncDone,
  resetCursor,
} from '../data/sync-store';
import { BlobRequestError, getBlob, putBlob } from './r2';

// Everything the engine needs to run a sync, passed in by the caller (SyncProvider)
// rather than read from session-store — so this module stays free of session/auth
// imports. The `username`/`encryptionKey` fields duplicate values the session
// already holds; that's deliberate decoupling, not redundancy.
export interface SyncDeps {
  username: string;
  // Non-extractable AES key from the session store; used to decrypt/encrypt R2 blobs.
  encryptionKey: CryptoKey;
  // The configured api client (createApiClient bound to this app's baseUrl + the
  // bearer-token authFetch). Passed in by the caller — the web app's SyncProvider
  // reads it from useApiClient(), the extension's background worker builds its own —
  // so the engine never reaches for an app-local `api` singleton or `process.env`.
  api: ApiClient;
  // SELECTIVE SYNC. When set, only paths it accepts are materialized into the local
  // store on a pull — the bracemark-extension is a selective client that wants just
  // `links/` + `extractions/` (+ lazy `files/`), not `tags/`/`lists/`/`pins/`/
  // `settings/`. It filters DOWNLOADS only: the cursor still advances across ALL ops
  // (so the next pull resumes correctly), deletes still apply to every path, and the
  // PUSH is never filtered (a client may still create a tag it doesn't materialize).
  // Omitted on bracemark-web → full sync, every namespace.
  pathFilter?: (path: string) => boolean;
}

// Batch/page sizes — this client's policy is to use the contract caps in full
// (anything ≤ the cap is valid; fewer round trips wins) — all but the content
// put chunk, CONTENT_PUT_BATCH below. A client-only knob, not contract.
const SIGN_BATCH = MAX_SIGN_PATHS;
const COMMIT_BATCH = MAX_COMMIT_OPS;
const OPS_PAGE = MAX_LIST_LIMIT;
const FILES_PAGE = MAX_LIST_LIMIT;

// Blob fan-out, split by SIZE rather than direction, because small and large
// blobs bind on opposite resources (a bounded cap also keeps a first sync of
// thousands of blobs from opening thousands of streams at once).
//
// A small blob is latency-bound. Each transfer is one blob-route request whose
// time is nearly all the Worker waiting on R2 — ~1.1 s a PUT and ~0.6 s a GET
// in the staging reading, against ~40 ms of wire — so the rate is the
// fan-out over that wait, and it scales with the fan-out until something else
// binds. The 2026-10-19 staging floor held its p50 at ~355 ms from 24 to 48 GETs
// at once; the server was not the limit (docs/local-first-sync.md, _measuring a
// sync_). The pass after it ran 42–47 of 48 in flight, so 96 is the next step,
// for a bulk edit's ~1,000 `links/` PUTs; not yet read. Every index blob
// (links/tags/lists/settings) is small, and so is a `files/` blob up to
// LARGE_CONTENT_BYTES, in either direction.
//
// A large `files/` blob is bound by bandwidth and memory — each transfer holds
// its blob in the JS heap, so peak ≈ concurrency × blob size — so it keeps the
// narrow fan-out, whether it is uploaded (uploadBlobs, through a gate inside the
// wide pass) or fetched (loadEntityContents, where the size is unknown until it
// arrives, so every content GET counts as large).
const INDEX_CONCURRENCY = 96;
const FILE_CONCURRENCY = 8;

// Where a `files/` upload stops counting as small. Sized against the one
// deadline it can miss: a web PUT gets BLOB_BASE_TIMEOUT_MS plus its size over
// BLOB_MIN_BYTES_PER_SEC (@stxapps/shared sync/blob-transfer.ts), so a 32 KiB
// blob has ~64 s. A full fan-out of them is 3 MiB, which a 512 kbps uplink
// moves in ~49 s — inside that, with the large gate's transfers alongside. Every
// seeded test library's content is far below it; a real preview image may not be.
// It is tied to INDEX_CONCURRENCY: the product, not either one, is what has to
// fit the deadline, so a wider fan-out halves this (64 KiB at 48 was the same 3 MiB).
const LARGE_CONTENT_BYTES = 32 * 1024;

// One put-pipeline pass (pushPuts) signs, uploads, and commits a single chunk, so
// a chunk must fit BOTH the sign cap and the commit cap in one call each, and it
// keeps each signed PUT URL's mint-to-PUT latency inside its own chunk's upload
// window. The chunk is also the step the pending count moves in: its ops leave the
// queue only when it commits (commitBatched). So the size is per blob kind, the
// same split as the fan-out above.
//
// Index: the full cap — the commit cap (500) is the smaller today. KB-sized blobs
// at INDEX_CONCURRENCY drain it in seconds, well under the 5-min TTL, and a smaller
// chunk would only spend more of bracemark-api's `tight` rate limit (10 calls per
// 10 s per user and per path, so files/sign and ops/commit each have a bucket and
// a chunk spends one call of each).
//
// Content: 100. At the full cap a `files/` chunk of MB-sized blobs ran for minutes
// on an ordinary uplink: minutes with the pending count frozen, and long enough for
// its tail to outlive the TTL. That expiry is absorbed per blob (uploadBlobs fails
// only its own op, the chunk commits what landed), but any failed content PUT holds
// the whole metadata phase until the next cycle. 100 is ~a minute at 1 MB a blob
// over 10 Mbps, gated FILE_CONCURRENCY wide. Small blobs go through at the full
// fan-out, a chunk in two or three rounds, and a chunk still spends one sign and
// one commit: under a second per chunk is what would reach either bucket's limit,
// and the commit alone measured ~1.6 s on staging.
const INDEX_PUT_BATCH = Math.min(SIGN_BATCH, COMMIT_BATCH);
const CONTENT_PUT_BATCH = 100;

// A path under `files/` is heavy content (a saved page copy, screenshot). Per the doc,
// content is fetched LAZILY (on open/scroll), never eagerly on sync — so sync only
// tracks its `updatedAt` and downloads the always-resident index (links/tags/lists/
// settings). loadEntityContent() pulls a content blob on demand.
function isContentPath(path: string): boolean {
  return path.startsWith(FILES_PREFIX);
}

// One path with the server `updatedAt` to store against it.
interface Entry {
  path: string;
  updatedAt: number;
}

// Every public flow rides a retrying api client: a 429 (bracemark-api's rate limits are
// shared buckets — another tab, another device on the account, a NATed neighbor —
// so no amount of client pacing can rule one out), a 5xx, or a network blip gets a
// few backed-off retries (honoring the server's Retry-After) instead of failing the
// whole cycle into bgSyncStatus 'error' and waiting for a human. Retrying at the
// CALL level, not the cycle level, keeps already-paged op-log/list work; a run that
// still fails after the retries surfaces exactly as before. Wrapped per flow (not
// stored) so SyncDeps stays a plain value the callers construct freely.
function withRetryDeps(deps: SyncDeps): SyncDeps {
  return { ...deps, api: withRetry(traceApi(deps.api, trace)) };
}

// The timing spans `measure:sync` reads (@stxapps/shared sync/trace.ts). Module
// state rather than a SyncDeps field because a trace belongs to the engine, not
// to a caller: overlapping callers share one cycle (runIncrementalSync), and the
// cycle is what is being timed. NO_TRACE unless installed — sync/trace.ts here
// installs a recorder behind a localStorage flag — and free while it is.
let trace: SyncTrace = NO_TRACE;

export function installSyncTrace(next: SyncTrace | undefined): void {
  trace = next ?? NO_TRACE;
}

// --- public flows -----------------------------------------------------------

// First sync after a fresh sign-in on this device (docs flow #1). List the full R2
// manifest, download + decrypt the index, build the local store — content is NOT
// pulled here. BLOCKING from the UI's point of view (InitialSyncGate shows the
// decrypting screen until this resolves).
//
// `onProgress` is the gate's counter feed, and it is a PARAMETER rather than a
// SyncDeps field on purpose: the providers build one `deps` and hand it to both
// flows, so a field here would also fire on every background cycle — and a
// background cycle has no blocked UI waiting on a count. Passing it per call makes
// "only the blocking pull reports progress" structural instead of a convention.
// It stays silent through the listing below (no denominator exists yet, and
// inventing one is the fake-progress-bar failure) — even though the GETs start
// on its first page — and the first tick arrives once the listing is done and
// the pull knows exactly how much it is fetching (startPull).
export async function runInitialSync(
  deps: SyncDeps,
  onProgress?: InitialSyncProgressFn,
): Promise<void> {
  deps = withRetryDeps(deps);
  // The bookkeeping row is claimed before this runs, under the lifecycle lock
  // (sync-store.ts, claimIfStillSignedIn). The engine never claims it: a stale
  // cycle must not recreate the row a teardown dropped.
  //
  // Under the cycle lock like any other cycle, and the flag is re-read inside it:
  // a second tab adopting the same sign-in waits here while the first one pulls,
  // and then has nothing left to do. That pull WAS this account's first sync on
  // this device — the store is complete up to its cursor, and listing the whole
  // namespace again would only hold the lock against the cycle that comes next.
  await withCycleLock(deps.username, async () => {
    if (await isFirstSyncDone(deps.username)) return;
    await trace.span('cycle', () => initialPull(deps, onProgress), { kind: 'initial' });
  });
}

async function initialPull(deps: SyncDeps, onProgress?: InitialSyncProgressFn): Promise<void> {
  // Read BEFORE the listing — it is the cursor this pull may claim once the
  // listing is stored, where the listing's own newest stamp is not.
  const watermark = await logWatermark(deps.api);
  // Each page is fetched as it is listed rather than after the whole listing: the
  // pages come one round trip at a time, and a GET has nothing to wait for but its
  // own page (startPull).
  const files = await trace.span('pull', async (note) => {
    let listed: Entry[] = [];
    await feedPull(startPull(deps, onProgress), async (pull) => {
      listed = await listAllFiles(deps.api, (page) => pull.add(page));
    });
    note({ entries: listed.length });
    return listed;
  });
  // The store is not always empty here. A pull that died partway (a dropped
  // connection, a closed tab) left what it had stored, and this is its retry —
  // minutes or days later, against a namespace that may have lost some of that
  // since. Such a path is in the store and not in the listing, and its delete op
  // was committed before the watermark above was read: at or below the cursor
  // this pull is about to claim, where no later pull returns it. So the claim is
  // only true if the listing is reconciled in BOTH directions, as the fallback
  // does it. On a fresh sign-in there is nothing local and this costs one read
  // of an empty key range.
  await applyDeletes(deps.username, await localOnlyPaths(files));
  await markFirstSyncDone(deps.username, watermark, '');
}

// ONE CYCLE AT A TIME PER ORIGIN, not per tab. `inflightSyncs` below is module
// state, so what it serializes is the cycles of one JS context — and every tab of
// the web app opens the same database, drains the same pending queue and moves the
// same cursor. Two tabs' cycles were two drains of one queue, and four things that
// are each sound for a single drain are not for two: the PUT is unconditional (the
// later arrival is the object, whatever order the edits were made in), a commit
// names a path rather than a write, the restamp is by path, and the pulled writes
// read "no op queued" as "no local write since this cycle decided". An older
// upload could land over a newer one and leave the SERVER holding the earlier of
// two edits made on this device, with nothing queued and nothing to retry
// (docs/local-first-sync.md, _two tabs, one queue_).
//
// A Web Lock spans every context of the origin — tabs, and the browser
// extension's pages and worker — and is released by the browser if its holder
// goes away, so a closed tab can't strand it. A cycle holds it from its read of
// the queue to its last write; a second tab's cycle waits and then reads the
// queue the first one left, which is all the single-drain reasoning ever needed.
// The wait is no new failure mode: it is the one an edit made mid-cycle already
// has inside a tab, and every call a cycle makes is bounded by a deadline
// (docs/api-contracts.md, _deadlines_).
//
// Per ACCOUNT, because that is what the queue and the cursor are scoped to: a
// stale cycle for an account that has since signed out is fenced in the database
// (AccountFencedError) and must not make the next account's first sync wait for
// its network calls to time out. And deliberately NOT the session lifecycle lock
// (data/session-store.ts, whose shape this follows): hydration takes that one on
// every startup, and holding it across a cycle's round trips would hold the app
// blank behind another tab's sync.
//
// Where Web Locks are missing there is only the in-context single-flight, as
// before — the lock narrows nothing there, it just isn't available to widen it.
const CYCLE_LOCK_PREFIX = 'bracemark-sync-cycle:';

function withCycleLock<T>(username: string, run: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return run();
  const asked = trace.now();
  return locks.request(`${CYCLE_LOCK_PREFIX}${username}`, () => {
    if (trace.enabled) trace.record({ name: 'cycle.lock', start: asked, end: trace.now() });
    return run();
  }) as Promise<T>;
}

// The cursor a LISTING-built flow (first sync, fallback) may claim: the op log's
// newest stamp, read before the listing starts.
//
// A paged R2 listing cannot supply its own cursor. It is not a snapshot — an
// object another client writes into a key range the listing has already passed is
// absent from it — so the newest stamp it shows says nothing about what it missed:
// an op stamped below that newest is then below the cursor for good, with no error
// and nothing to retry. That is not hypothetical bookkeeping; a new device signing
// in while another one was saving came up short by exactly the links that had
// landed behind the listing.
//
// The log's high-water mark can make the claim, by three properties that already
// hold. Every op at or below it was committed before this read, and a commit is
// R2-first, log-last — so a listing that starts afterwards reflects it. The commit
// clamp stamps every later op strictly above it (bracemark-api do/user-data.ts) —
// so the next incremental pull lists it. And R2 lists after a write consistently.
// Nothing here compares R2's clock with the log's, which the old reconstruction
// had to.
//
// `(watermark, '')` rather than the exact key of the newest op: the wire carries
// no path with the bounds, and an empty `sincePath` re-lists the ops stamped at
// exactly that millisecond. Replaying them is idempotent and storeDownloads'
// staleness skip absorbs it. An empty log (a brand-new account, or one wiped under
// us) reads as 0 — `(0, '')`, which claims nothing and routes the next cycle to
// the fallback again until the log has something to stand on.
async function logWatermark(api: ApiClient): Promise<number> {
  const { newestUpdatedAt } = await api.call(opsListEndpoint, { since: 0, limit: 1 });
  return newestUpdatedAt ?? 0;
}

// Single-flight per account, per JS context. Overlapping calls (the post-ready
// background pull, an edit-triggered requestSync, a retry) coalesce: a caller
// during a run shares the in-flight promise, and at most one trailing rerun picks
// up whatever changed after that run's snapshot. That keeps THIS context to one
// cycle and gives its callers one promise to share; what keeps two contexts' cycles
// apart is the cycle lock above, which each run takes for itself — so a tab running
// reruns back to back still lets another tab's cycle in between them.
const inflightSyncs = new Map<string, Promise<SyncOutcome>>();
const rerunRequests = new Set<string>();

// Run `work` with this account's sync cycles held off: a cycle already running
// is waited out first, and one asked for meanwhile waits until `work` settles.
// For the delete-all flow, whose server wipe must have no cycle beside it — one
// that read the pending queue would push it past the wipe and bring back what
// the user deleted, and one that pulled meanwhile could land the server's copy
// over an edit the wipe was then refused for.
//
// It IS the cycle lock, so a cycle in another tab is held off as well as this
// one's: they all drain the same queue. A cycle of this context's asked for
// meanwhile still joins its single-flight slot as usual; its run just queues
// behind `work` for the lock. Where Web Locks are missing there is no lock to
// take, and this narrows to what every cycle gets there: this context's cycle is
// waited out, and nothing holds the next one off.
//
// `onWait` fires only when there is a cycle to wait for, so a delete view does
// not flash a false waiting step. `signal` aborts the WAIT and never the work:
// once the lock is held, `work` runs to the end. The deadline and its wording
// are the caller's (the delete flow's watchdog), not the engine's.
export async function holdSyncCycles<T>(
  username: string,
  work: () => Promise<T>,
  { onWait, signal }: { onWait?: () => void; signal?: AbortSignal } = {},
): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) {
    const inflight = inflightSyncs.get(username);
    if (inflight) {
      onWait?.();
      await untilAborted(
        inflight.then(
          () => undefined,
          () => undefined,
        ),
        signal,
      );
    }
    signal?.throwIfAborted();
    return work();
  }
  const name = `${CYCLE_LOCK_PREFIX}${username}`;
  // Free right now: take it without reporting a wait. `ifAvailable` grants a null
  // lock instead of queueing, which is the "there is a cycle" answer.
  const held = await locks.request(name, { ifAvailable: true }, async (lock) =>
    lock ? { value: await work() } : undefined,
  );
  if (held) return held.value;
  onWait?.();
  return locks.request(name, { signal }, work);
}

// A returning-visit sync (docs flow #2 + "a sync cycle"): reconcile, then push,
// then pull. Non-blocking — failures surface a quiet retry, they don't gate the
// UI. Routes itself to the download-authoritative fallback when the op log can't
// answer (wiped, compacted past the cursor, or behind it).
//
// REJECTS on a failed cycle — that's the contract every caller is written
// against: the web SyncProvider's rejection branch sets bgSyncStatus 'error',
// the extension's runSync catch does the same via storage, and the export flow
// downgrades a failed pre-export refresh to a warning. Coalesced callers share
// the in-flight promise, so they share its rejection too — all of them handle it.
//
// RESOLVES with a SyncOutcome, because "it worked" is no longer the only good
// answer: a cycle can complete with part of the push refused by the plan/quota
// gate (signPushable, below). Callers that only care about failure can ignore
// the value; the providers map it through shared's `bgStatusForOutcome` to show
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

// One cycle, under the cycle lock from its first read to its last write. The queue
// snapshot and the cursor are read INSIDE the lock on purpose: a cycle that waited
// for another tab's must see what that one left behind, not what was there when it
// asked.
//
// `async` is load-bearing, though nothing here awaits. runIncrementalSync sets the
// single-flight slot AFTER creating the promise whose `finally` clears it, so a
// SYNCHRONOUS throw from here would run that `finally` first and the `set`
// second — leaving a rejected promise in the slot, which every later sync on the
// page then joins. Taking the lock is the first thing a cycle does, and an
// `async` function turns a lock API that throws (rather than rejects) into a
// rejection the slot survives.
async function incrementalSyncOnce(deps: SyncDeps): Promise<SyncOutcome> {
  return withCycleLock(deps.username, () => runCycle(deps));
}

async function runCycle(deps: SyncDeps): Promise<SyncOutcome> {
  deps = withRetryDeps(deps);
  // Collected DOWN the call chain (the cycles → pushPending → pushPuts) and
  // returned UP, so the provider can tell a clean cycle from one the quota gate
  // clipped without either of them inspecting an error.
  const outcome = emptySyncOutcome();
  const meta = await getSyncMeta(deps.username);
  // The cursor is the compound key (updatedAt, path); both halves go over the wire
  // as opsListEndpoint's `since` + `sincePath`. `since` is always sent (even 0, for
  // a seeded-but-empty new account) so the server's bounds can route us; an empty
  // `sincePath` is omitted (server reads it as the low sentinel).
  const since = meta?.syncCursorUpdatedAt ?? 0;
  const sincePath = meta?.syncCursorPath ?? '';
  const pending = await trace.span('queue.read', () => listPendingOps(deps.username));

  // Peek the first page: its retained-range bounds decide incremental vs. fallback
  // before we commit to paging the op log.
  const first = await deps.api.call(opsListEndpoint, {
    since,
    sincePath: sincePath || undefined,
    limit: OPS_PAGE,
  });

  if (needsFallback(since, first)) {
    // `first` was answered before the listing the fallback is about to take, so
    // its newest stamp is the high-water mark that listing will reflect — the
    // same read logWatermark makes for a first sync, already in hand.
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
// `files/{id}.enc` blob on demand (open/scroll), decrypt, and cache it in Dexie so
// re-views are instant and offline. Returns the decrypted bytes, or undefined if
// the path isn't known locally — or no longer exists server-side (deleted on
// another device, the delete op not yet pulled; the next sync removes the record).
export async function loadEntityContent(
  deps: SyncDeps,
  path: string,
): Promise<Uint8Array | undefined> {
  const rec = await db.items.get(path);
  if (!rec) return undefined;
  if (rec.data) return rec.data;

  const signed = (await signPaths(withRetry(deps.api), 'get', [path])).get(path);
  if (!signed) return undefined;

  const blob = await getBlobRetrying(signed).catch((err: unknown) => {
    if (err instanceof BlobRequestError && err.status === 404) return undefined;
    throw err;
  });
  if (!blob) return undefined;

  const data = await decryptEntity(deps.encryptionKey, blob, path);
  // Cache under a compare-and-set on the stamp read at the top: a sync pull can
  // restamp this path mid-fetch (newer `updatedAt`, cached `data` dropped), and
  // landing the older blob under the new stamp would serve stale content FOREVER —
  // the engine's staleness skip only re-downloads when the server stamp moves
  // again. Losing the race just skips the cache: the caller still gets the bytes
  // it asked for, and the next call fetches the newer version.
  //
  // expo's loadEntityContent answers the same race with `undefined` instead, and
  // that difference is the storage talking, not a policy split: expo decrypts
  // straight into the path's one canonical file, so a lost race leaves a file the
  // row doesn't claim and a concurrent pull may tear down — it deletes it rather
  // than hand it out. Bytes in hand have no such owner. A caller written against
  // both must read `undefined` as "not now", not "gone".
  await db.transaction('rw', db.items, db.syncMeta, async () => {
    await assertAccountStillOwnsStore(deps.username);
    const current = await db.items.get(path);
    if (current?.updatedAt === rec.updatedAt) await db.items.update(path, { data });
  });
  return data;
}

// Batch counterpart of loadEntityContent, for a caller that needs MANY `files/`
// blobs resident at once (the export flow's download phase). Same semantics per
// path — fetch, decrypt, persist into the local store so re-runs are resumable
// and offline reads work — but signed in SIGN_BATCH pages (one `files/sign` call
// per ~1000 paths instead of one per file) and fetched at FILE_CONCURRENCY, not
// the index fan-out: each in-flight fetch holds an MB-sized ciphertext and then
// its plaintext in the JS heap. Already-resident bytes are skipped (and don't count
// toward progress); a path that's unknown locally, 404s on GET (deleted on another
// device, the delete op not yet pulled) or does not open under its path
// (openPulled) lands in `missingPaths` for the caller to report — never a thrown
// error. Any other failure rejects. The unreadable case is the one that has to be
// per path: rejected, one bad blob failed the whole batch on every attempt, so an
// export could never finish and the content provider re-asked for the whole batch
// on every mount.
//
// `bestEffort` turns those other failures — a transport failure: offline, a
// non-404 status, a deadline, on the sign call or on a GET — into `failedPaths`
// as well, and the batch carries on. The export wants that, where a backup
// missing a few images beats no backup, and an offline export used to fail
// outright on its first unfetched blob. The content provider must not have it:
// it remembers `missingPaths` for the session and retries only on a rejection,
// so the two lists stay apart. A failed sign call fails every path left, since
// it is one endpoint and the call has already been retried. Even best-effort
// rejects on `session_revoked` — this device is being told to forget, and the
// caller is about to write the library out — and on a fenced store write.
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

  const records = await db.items.bulkGet(paths);
  const missingPaths: string[] = [];
  const wanted: string[] = [];
  // The stamp each fetch starts from, for the same compare-and-set cache write
  // loadEntityContent does (see there): a path restamped mid-fetch skips the cache
  // rather than pinning old bytes under the new stamp.
  const baseStamps = new Map<string, number>();
  paths.forEach((path, i) => {
    const rec = records[i];
    if (!rec) missingPaths.push(path);
    else if (!rec.data) {
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
      let data: Uint8Array | undefined;
      try {
        const blob = signed
          ? await getBlobRetrying(signed).catch((err: unknown) => {
              if (err instanceof BlobRequestError && err.status === 404) return undefined;
              throw err;
            })
          : undefined;
        data = blob && (await openPulled(deps, blob, path));
      } catch (err) {
        if (!tolerates(err)) throw err;
        failedPaths.push(path);
        reportOne();
        return;
      }
      if (data) {
        await db.transaction('rw', db.items, db.syncMeta, async () => {
          await assertAccountStillOwnsStore(deps.username);
          const current = await db.items.get(path);
          if (current?.updatedAt === baseStamps.get(path)) await db.items.update(path, { data });
        });
      } else {
        missingPaths.push(path);
      }
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

  // 2. Reconcile pulled ops against the pending queue. A path with a pending op is
  // a local edit; LWW resolves a true conflict (server moved past our base) the
  // same way as a clean fast-forward — local-wins (upload) — so EVERY pending op
  // goes to the push set and the download set is only the server-only paths. (Which
  // side wins a true conflict is an open product call; local-wins matches "the
  // later PUT wins" and is what the deferred conditional-write upgrade turns into a
  // detected 412 + re-pull.)
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
  const orphanedPaths = await pushPending(deps, pending, outcome);
  // Complete the self-heal: a wedged op the push dropped (uploadBlobs) had its path
  // reserved for the push by the reconcile above, keeping the server's copy OUT of
  // the download set — re-add whatever this window shows for it, so the heal
  // restores the entity instead of leaving the path locally absent. (A path with no
  // op in the window stays absent until a fallback re-lists it — the op that put it
  // there is behind the cursor.)
  for (const path of orphanedPaths) {
    const op = serverOps.get(path);
    if (op?.op === 'put') downloads.push({ path: op.path, updatedAt: op.updatedAt });
  }
  await storeDownloads(deps, downloads);
  await applyDeletes(deps.username, localDeletes);

  // 5. Advance the cursor over what this cycle LISTED — and not over its own
  // commits, which is what this step used to fold in. The commit clamp stamps a
  // commit above everything already in the log, INCLUDING an op another client
  // committed after the last list page above; a cursor at our own stamp therefore
  // claims a range nobody read, and the keyset pull never returns what is below
  // it. That lost links between two devices that were merely in use at the same
  // time, silently and for good: the cycle completed, the queue drained, and the
  // cursor sat inside the log's range, so nothing routed a fallback either.
  //
  // The next cycle lists our commits back instead, and that echo costs an op row
  // each and no transfer: the commit restamped every record to the very stamp its
  // op carries, so storeDownloads' staleness skip passes over it, and an echoed
  // delete finds no record to remove.
  await advanceCursor(deps.username, cursorUpdatedAt, cursorPath);
}

// --- the cycle: fallback (download-authoritative) ---------------------------

// When the op log can't reconstruct the delta, reconcile directly against a full
// R2 listing (docs "fallback full sync"). The server list is truth for every path
// WITHOUT a pending local op — so a server-side deletion is never resurrected and
// a stale leftover is dropped. A pending op is a genuine unsynced local intent,
// resolved exactly as the incremental cycle resolves it — local-wins — so a
// fallback (an infra event: log wiped/compacted/reset) never silently flips a
// conflict to server-wins: a pending edit is pushed over the server copy, and a
// pending delete is pushed rather than resurrected by the listing.
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

  // One key-only cursor over the local table projects path -> updatedAt WITHOUT
  // deserializing any `data` blob: eachKey runs an IndexedDB key cursor on the
  // `updatedAt` index, so the heavy index-record bytes never load (the index key is
  // updatedAt, cursor.primaryKey is the path). It feeds BOTH reconcile directions
  // below — replacing a full-record bulkGet of every file plus a second primary-key
  // scan with this single pass.
  const localUpdatedAt = new Map<string, number>();
  await db.items.orderBy('updatedAt').eachKey((updatedAt, cursor) => {
    localUpdatedAt.set(cursor.primaryKey as string, updatedAt as number);
  });

  // Server side: download anything new or newer than the stored local `updatedAt`
  // — except paths with a pending op, which local-wins reserves for the push.
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
  // delete (the re-commit costs one redundant op row), but it can also be OUR OWN
  // commit that crashed between the R2 delete and the DO write — and then this
  // retry is the only thing that ever logs the op (so incremental pullers learn of
  // the deletion) and frees the path's file_sizes quota entry. Commit is idempotent
  // on both stores, so pushing unconditionally is always safe; dropping the op
  // would leak the quota entry forever.
  const orphanedPaths = await pushPending(deps, pending, outcome);
  // Same heal as the incremental cycle: a dropped op's path was excluded from the
  // download set above — re-add the listed server copy so it comes back.
  for (const path of orphanedPaths) {
    const updatedAt = serverFiles.get(path);
    if (updatedAt !== undefined) downloads.push({ path, updatedAt });
  }
  await storeDownloads(deps, downloads);
  await applyDeletes(deps.username, localDeletes);

  // Cursor = the log's high-water mark as it stood BEFORE the listing — not the
  // newest of the listing and our own commits, which this used to be and which
  // could sit above an op nobody had read, twice over: the listing is not a
  // snapshot, and our commits are stamped past whatever another client committed
  // while we pushed. Everything at or below the watermark is in the listing just
  // reconciled; everything since, our own commits included, is above it and comes
  // back on the next pull.
  //
  // resetCursor, not advanceCursor, because this still has to LOWER a cursor that
  // is ahead of a reset log — and an empty log leaves `(0, '')`, which routes the
  // next cycle here again rather than claiming anything.
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

// Drain a set of pending ops: sign → PUT → commit (docs flow #3). Returns the paths
// of ops the self-heal dropped (uploadBlobs) so the caller can re-add their server
// copies to its download set — and nothing about what it committed: each commit's
// stamp belongs on the record it names (commitBatched), never on the cursor, which
// moves only over ops a cycle listed. Removes each committed op from the queue; a
// `no_object` failure is left queued to re-PUT next drain.
//
// Runs in the global phase order [delete-metadata, delete-content, put-content,
// put-metadata] — the mirror pair of the multi-file-consistency rules (docs
// "multi-file consistency"): a create writes content before the metadata that
// references it; a delete removes that metadata before the content it referenced.
// So no crash or partial push ever leaves metadata pointing at a missing content
// file. Crucially each PHASE commits durably before the next, and each CHUNK within
// the put phases signs + uploads + commits as one unit (pushPuts) — so a signed
// PUT URL never outlives its own chunk's upload window, and a push too large to
// finish inside one 5-min TTL still makes monotonic progress instead of livelocking
// on an all-up-front sign whose tail expires before it can be uploaded.
//
// THROWS after the phases when any upload transiently failed — not before them, so
// the cycle keeps its progress (committed chunks stay committed; failed ops stay
// queued for fresh URLs next drain), and not silently, because a rejection is the
// contract every caller schedules a retry and shows an error status through.
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
  // delete (the client can't; files/sign mints only PUT/GET URLs). Metadata first,
  // then content. Unlike the puts below this is ONE call, not two: commitBatched
  // commits its input in array order across sequential chunks, so the concatenation
  // already IS the phase order — every entity's metadata-delete commits no later than
  // its content-delete. The one chunk that can straddle the metadata/content boundary
  // commits both in a single atomic log write (the safe direction, never
  // content-before-metadata), so splitting it would only cost a redundant partial
  // commit when the metadata count isn't a multiple of COMMIT_BATCH.
  await commitBatched(deps, [
    ...deletes.filter((o) => !isContentPath(o.path)),
    ...deletes.filter((o) => isContentPath(o.path)),
  ]);

  // Phase 3 then 4: drain ALL content puts (every chunk, every commit) before ANY
  // metadata put, so the content-before-metadata invariant holds across chunk
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
  // A content upload that failed left its op queued — so the metadata phase (which
  // may reference that content) is HELD this cycle, or a puller could land metadata
  // whose content 404s: the exact breach the phase order exists to prevent. Held
  // wholesale because the engine is schema-blind — it can't tell which metadata is
  // safe. The held ops just stay queued; the next drain retries both halves in order.
  //
  // Content the quota gate refused is held behind for the same reason. Asking the
  // gate again would usually be refused too — it reads usage, and usage only grew —
  // but not always: a delete committed by another device, or a purchase that raised
  // the ceiling, can land between the two sign calls, and the metadata phase would
  // then go up without the content it names. The held ops count as blocked: they
  // are stuck behind the refusal, and the next cycle that fits pushes both halves.
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

// Drive a homogeneous put set (all content OR all metadata — the caller splits and
// orders them) through the sign → PUT → commit pipeline one chunk at a time, so each
// chunk's PUT URLs are minted immediately before that chunk's upload. `batchSize`
// (≤ both caps) keeps the sign and the commit a single round trip each; it and
// `concurrency` are the set's kind's. Resolves true when the quota gate refused the
// set — the caller holds the metadata phase on it, as it does on a failed upload.
//
// A CHUNK'S COMMIT OVERLAPS THE NEXT CHUNK'S SIGN AND UPLOAD. The commit is a
// round trip of its own (~1.6 s on staging, most of it R2 answering the existence
// check), and run in line it left the fan-out idle for that long eight times in a
// 1,000-link push. It runs behind the next chunk instead, and what made the line
// safe still holds:
//
//  - Commits stay in order. One is in flight at most, each starting once the one
//    before has landed, so the op log takes them in input order and a failed one
//    stops the set.
//  - The pending count still steps down per chunk, at most one chunk behind.
//  - The next chunk's tokens are minted after this chunk's upload ended, so the
//    mint-to-PUT latency the chunking bounds grows by nothing.
//  - Nothing leaves while a commit is in flight. The set resolves only once its
//    last commit has — which is the phase barrier pushPhases relies on — and a
//    throw waits for the one in flight before it rejects, so a failed cycle never
//    lets the next one read a queue a commit is still clearing.
//
// What it does loosen is the quota gate's view: `files/sign` reads usage the
// commits record, and a chunk signed beside the previous one's commit is checked
// without it. The gate already charges each batch's growth to the next one (api
// lib/quota.ts — a cost backstop), so the overshoot it allows grows from one
// chunk to two.
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
      // The quota gate refuses on the account's usage, never on which paths a chunk
      // holds, so every later chunk of this set would be refused too: record them
      // without asking. One refused sign call per put phase, not per chunk — which
      // CONTENT_PUT_BATCH would otherwise multiply against the rate limit.
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
    uploaded: UploadedChunk,
    attrs: { kind: string; ops: number },
    start: number,
  ): Promise<void> {
    await commitBatched(deps, uploaded.ops, uploaded.receipts);
    if (trace.enabled) trace.record({ name: 'push.chunk', start, end: trace.now(), attrs });
  }

  // Upload one signed chunk and return the ops its commit should carry, with the
  // upload receipts their PUTs answered with.
  async function uploadChunk(signed: {
    ops: PendingOpRecord[];
    urls: Map<string, SignedUrl>;
  }): Promise<UploadedChunk> {
    const { orphaned, failed, superseded, receipts } = await trace.span(
      'upload',
      () => uploadBlobs(deps, signed.ops, signed.urls, concurrency, failures),
      { ops: signed.ops.length, concurrency },
    );
    // A put with no local bytes left (see uploadBlobs) can never be satisfied, so it is
    // dropped from the queue rather than committed into a guaranteed `no_object` that
    // requeues it forever. Dropped BEFORE the commit, so the op log never records an op
    // for an object we didn't upload (the "no op without its object" invariant) — and
    // by compare-and-delete, so a re-create that landed mid-cycle keeps its own op.
    let uploaded = signed.ops;
    if (orphaned.length > 0) {
      await clearDrainedOps(orphaned);
      orphanedPaths.push(...orphaned.map((o) => o.path));
      const dropped = new Set(orphaned.map((o) => o.path));
      uploaded = uploaded.filter((o) => !dropped.has(o.path));
    }
    // A transiently-failed PUT stays queued but is excluded from the commit: unlike an
    // unsigned path there is nothing gained by asking the server to HEAD an object we
    // know we didn't send — on a big failed chunk that's up to a chunk's worth (100 or
    // 500) of doomed entries per cycle — and the failure is already surfaced through
    // `failures`.
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
    return { ops: uploaded, receipts };
  }
}

// One chunk's uploaded ops and, by path, the upload receipt each PUT answered
// with (sync/r2.ts putBlob) — the receipts ride the chunk's commit (commitOne).
// Kept in memory only, never in the queue: a receipt is good for the commit
// that follows its upload, and an op whose commit never happens is re-PUT next
// drain, which answers with a fresh one.
interface UploadedChunk {
  ops: PendingOpRecord[];
  receipts: ReadonlyMap<string, string>;
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
// branch is gone with the cap itself: it is enforced on the create surfaces now,
// so an over-cap link is refused before it is ever
// written and never becomes a pending op.
//
// Blocked ops stay QUEUED, deliberately — they are the user's data, and they
// must upload the moment the account is back under its limits. The cost is one
// refused sign call per cycle (pushPuts stops a phase at its first refusal, and a
// refused content phase holds the metadata phase unasked), and it is what makes
// recovery automatic rather than something the user has to know to trigger.
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

// Commit a sequence of ops in input order, chunked under the commit cap — batches go
// out sequentially, so the caller's phase ordering is preserved across chunks. For
// each committed put, stamp R2's authoritative `updatedAt` onto the local record (a
// delete has no record left to stamp — update is a no-op), then clear the ops it
// accepted. `failed` (only `no_object` today) is intentionally ignored: leaving the
// path queued is exactly the retry.
//
// A put goes with its upload receipt when its PUT answered with one, so the server
// can record it without asking R2 whether it landed — what kept a commit's time
// growing with the size of the library (docs/local-first-sync.md, _upload
// receipts_). A put without one is checked against R2 as before; a receipt is
// never what decides whether the op commits.
//
// The clear takes the OP ROWS this drain read, not the committed paths, so it removes
// only the writes it actually pushed (clearDrainedOps): an edit made during the push
// sits at the same path under a new `writeId` and must outlive this commit — its bytes
// are not the bytes that just went up. The restamp is unconditional even then: R2 does
// hold that path at `r.updatedAt` now, and the surviving op keeps its own older base,
// which local-wins reconcile never reads against it.
async function commitBatched(
  deps: SyncDeps,
  ops: PendingOpRecord[],
  receipts: ReadonlyMap<string, string> = NO_RECEIPTS,
): Promise<void> {
  for (const batch of chunk(ops, COMMIT_BATCH)) {
    await trace.span('commit', () => commitOne(deps, batch, receipts), {
      ops: batch.length,
      receipts: batch.filter((o) => receipts.has(o.path)).length,
    });
  }
}

const NO_RECEIPTS: ReadonlyMap<string, string> = new Map();

async function commitOne(
  deps: SyncDeps,
  batch: PendingOpRecord[],
  receipts: ReadonlyMap<string, string>,
): Promise<void> {
  const { results } = await deps.api.call(opsCommitEndpoint, {
    ops: batch.map((o) => {
      const receipt = o.op === 'put' ? receipts.get(o.path) : undefined;
      return receipt ? { op: o.op, path: o.path, receipt } : { op: o.op, path: o.path };
    }),
  });
  // All of a batch's restamps share one rw transaction — update() per result
  // opened a transaction each, which made a 1000-op commit pay a thousand IDB
  // round trips for what is one logical write. update() still no-ops per row
  // when the record is gone (a committed delete has nothing to stamp).
  await trace.span('commit.restamp', () =>
    db.transaction('rw', db.items, db.syncMeta, async () => {
      await assertAccountStillOwnsStore(deps.username);
      for (const r of results) await db.items.update(r.path, { updatedAt: r.updatedAt });
    }),
  );
  const accepted = new Set(results.map((r) => r.path));
  await trace.span('commit.clear', () =>
    clearDrainedOps(batch.filter((o) => accepted.has(o.path))),
  );
}

// Encrypt and PUT each op's local blob to its signed URL — THE WRITE THE OP STANDS
// FOR, or nothing. An op carries no bytes; its record is read here, when its own
// upload starts, which can be many round trips after the cycle read the queue. So
// the record is read TOGETHER WITH the queue row at its path, in one transaction,
// and uploaded only if that row is still the op this cycle holds. A write replaces
// the row's `writeId` in the same transaction that stores its bytes
// (data/mutations.ts writeBytesWith), so a matching id means these are exactly the
// bytes this op was queued for.
//
// Without that test the phase order held over the OPS and broke over the BYTES. A
// metadata op queued before the cycle uploaded whatever its record held by then —
// including a reference to a `files/` blob written since, which this cycle holds no
// op for and has not sent: server extraction's second pass, or a custom image set
// on a link with an edit already queued. The cycle committed metadata naming
// content the server did not have, the very state content-before-metadata exists
// to rule out, and another device pulling in that window got a preview it could
// not load.
//
// Sorts the ops it could not move into three buckets the caller treats
// differently, because the four skip shapes look alike and are not:
//
//  - `superseded` — the queue row at this path is no longer this op: a later write
//    replaced it (a re-edit, or a delete), or it is gone. NOT a failure and nothing
//    to retry here — the later write is queued under its own `writeId`, and the
//    cycle that reads THAT op pushes it, with the content it names, in phase order.
//    Checked first, because a path deleted since the queue was read has no record
//    either, and it is a newer intent, not an orphan: healing it would fetch the
//    server's copy of something this device just deleted.
//  - `orphaned` — the row IS still this op, and there is no local record, or one
//    stripped of its bytes. TERMINAL: a write puts the record and enqueues its op
//    in one transaction, so an op without bytes is never a write that hasn't
//    landed yet — it is a record that went missing underneath a queued op, and
//    nothing will ever put those bytes back. Retrying is a permanent wedge (the
//    pending count sticks above zero forever), so the caller drops it. Since
//    applyDeletes stopped producing that state it should be unreachable; it stays
//    as the self-heal for queues already wedged by it, because a queue that can't
//    drain is invisible to every other repair.
//  - `failed` — the PUT itself threw (network blip, an expired signed URL on a
//    chunk that outlived the TTL). TRANSIENT: the op stays queued and re-signs
//    next drain; recorded on `failures` so the cycle still rejects after the
//    phases instead of reporting a false 'idle'. Caught per op, so one bad blob
//    no longer aborts its whole chunk before the chunk could commit anything —
//    which on a chunk too big for one TTL window was a deterministic livelock.
//  - an unsigned path (no URL came back): also transient — leaving it queued IS
//    the retry, and the commit's `no_object` is the honest report.
//
// A `files/` blob past LARGE_CONTENT_BYTES waits for one of FILE_CONCURRENCY
// slots inside the pass's own fan-out, and lets go of its bytes while it waits:
// its size is known only once its record is read, and a pass of large blobs each
// holding its bytes in a queue would put the full fan-out of them in the heap.
// It reads its record again once it has a slot — the same paired read, so the
// writeId test is taken again on the bytes it actually sends.
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
  receipts: Map<string, string>;
}> {
  const orphaned: PendingOpRecord[] = [];
  const failed: PendingOpRecord[] = [];
  const superseded: PendingOpRecord[] = [];
  // Each landed PUT's upload receipt, by path, for the commit (commitBatched).
  const receipts = new Map<string, string>();
  const largeGate = createLimiter(FILE_CONCURRENCY);

  // The op's bytes if its queue row is still this op, sorted into its bucket if not.
  const readForUpload = async (op: PendingOpRecord): Promise<Uint8Array | undefined> => {
    // One read transaction for the pair, so no local write can land between the
    // row and the record it describes — IndexedDB orders this against the write
    // edge's rw transactions on the same two stores.
    const { rec, queued } = await trace.span('blob.read', () =>
      db.transaction('r', db.items, db.pendingOps, async () => ({
        rec: await db.items.get(op.path),
        queued: await db.pendingOps.get([op.username, op.path]),
      })),
    );
    if (queued?.writeId !== op.writeId) {
      superseded.push(op);
      return undefined;
    }
    if (!rec?.data) {
      orphaned.push(op);
      return undefined;
    }
    return rec.data;
  };

  await mapLimit(ops, concurrency, async (op) => {
    let data = await readForUpload(op);
    if (!data) return;

    const signed = urls.get(op.path);
    if (!signed) return;

    if (isContentPath(op.path) && data.byteLength > LARGE_CONTENT_BYTES) {
      data = undefined;
      await largeGate(async () => {
        const held = await readForUpload(op);
        if (held) await send(op, held, signed);
      });
      return;
    }
    await send(op, data, signed);
  });
  return { orphaned, failed, superseded, receipts };

  async function send(op: PendingOpRecord, data: Uint8Array, signed: SignedUrl): Promise<void> {
    const ns = syncNamespace(op.path);
    try {
      const sealed = await trace.span('blob.encrypt', () =>
        encryptEntity(deps.encryptionKey, data, op.path),
      );
      // A 5xx, a 429 or a dropped connection is tried again here rather than
      // failing the cycle — one span per attempt, so a retried PUT shows in the
      // trace as a failed one before it (@stxapps/shared sync/blob-transfer.ts,
      // retryTransientBlobTransfer).
      const receipt = await retryTransientBlobTransfer(
        () =>
          trace.span('blob.put', () => putBlob(signed.url, sealed, signed.authorization), {
            bytes: sealed.byteLength,
            ns,
          }),
        isTransientBlobError,
      );
      if (receipt) receipts.set(op.path, receipt);
    } catch (err) {
      failed.push(op);
      failures.count += 1;
      failures.firstError ??= err;
    }
  }
}

// A transfer the host refused for now, not on its merits, or one the connection
// under it dropped — what `send` and every download try again (@stxapps/shared
// sync/blob-transfer.ts). A browser's fetch rejects with a TypeError only when the
// transport failed: an abort is a DOMException, and these transfers have no abort
// but their deadline, which rejects first as a BlobTimeoutError (sync/r2.ts).
function isTransientBlobError(err: unknown): boolean {
  if (err instanceof TypeError) return true;
  return err instanceof BlobRequestError && isTransientBlobStatus(err.status);
}

// One GET, tried again on a 5xx, a 429 or a dropped connection. The 404 a caller
// skips is not transient, so it still reaches the caller on the first try.
function getBlobRetrying(signed: SignedUrl): Promise<Uint8Array> {
  return retryTransientBlobTransfer(
    () => getBlob(signed.url, signed.authorization),
    isTransientBlobError,
  );
}

// --- download / store / delete ----------------------------------------------

// Fetch, decrypt, and store a set of entries. Content (`files/`) records keep only
// their `updatedAt` — the blob stays lazy (and a CHANGED record drops any
// previously-cached `data` so a stale copy isn't served after an update). The index
// is fetched by one fan-out that signs its GET URLs a batch at a time, so the URL
// set never outgrows about one batch (startPull).
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

// A pull in progress. Entries go in as they are known — a cycle's whole set at once,
// or a first sync's listing a page at a time (initialPull) — and every index GET
// rides one fan-out (@stxapps/shared createSignedFanOut), so a page's downloads
// start while the next page is still being listed, and no batch waits for the last
// one's slowest GET.
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
  // after both filters in `add`. It is reported only once it is final — at
  // `finish`, when no more entries can come — because a first sync adds a page at
  // a time, and a total that grew under the bar would be the fake-progress failure
  // the gate refuses. So the gate stays indeterminate through the listing, as it
  // always did, and its first tick may already count GETs the early pages
  // finished. Nothing to fetch reports nothing at all: the gate reads that as
  // "still working" and stays indeterminate, which beats flashing a full bar over a
  // pull that is already over. Content records are excluded because their blobs
  // aren't downloaded here (only their `updatedAt` rows are) — counting them would
  // inflate the total with work that costs no time.
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

      // A 5xx, a 429 or a dropped connection is tried again, one span per
      // attempt, as an upload's is.
      const blob = await retryTransientBlobTransfer(
        () =>
          trace.span(
            'blob.get',
            (note) =>
              getBlob(signed.url, signed.authorization).then(
                (bytes) => {
                  note({ bytes: bytes.byteLength });
                  return bytes;
                },
                (err: unknown) => {
                  // Deleted between the op pull / listing and this GET: the delete op
                  // sits past our window and reconciles next sync — skip it, don't
                  // fail the cycle.
                  if (err instanceof BlobRequestError && err.status === 404) return undefined;
                  throw err;
                },
              ),
            { ns: syncNamespace(e.path) },
          ),
        isTransientBlobError,
      );
      if (!blob) return;

      const data = await trace.span('blob.decrypt', () => openPulled(deps, blob, e.path));
      if (!data) return;
      await trace.span('blob.store', () =>
        putPulled(deps.username, [toItemRecord(e.path, e.updatedAt, data)]),
      );
    } finally {
      done += 1;
      report();
    }
  };

  // Index: sign → GET → decrypt → store, one signed batch ahead of the GETs, so the
  // signed-URL set never grows past about one batch (a large first sync holds ~1k
  // URLs, not all of them) and each URL's mint-to-GET latency stays well inside its
  // 1-hour TTL. Each record is stored the moment it's decrypted, so an interrupted
  // run resumes via the staleness skip in `add` (fresh URLs for the shrinking
  // remainder) rather than restarting.
  const fanOut = createSignedFanOut<Entry, SignedUrl>({
    concurrency: INDEX_CONCURRENCY,
    signBatch: SIGN_BATCH,
    sign: (paths) => signPaths(deps.api, 'get', paths),
    run: pullOne,
  });

  return {
    async add(entries) {
      // Selective sync: drop the namespaces this client doesn't materialize before
      // any sign/GET work (the cursor is advanced by the caller from the full op/file
      // set, so skipping these downloads never strands it). A no-op for a full-sync
      // client.
      const { pathFilter } = deps;
      if (pathFilter) entries = entries.filter((e) => pathFilter(e.path));
      if (entries.length === 0) return;

      // Skip paths whose local record is already current (same-or-newer server stamp,
      // with the decrypted bytes present for an index path). That makes a re-run of an
      // interrupted first sync RESUME instead of re-downloading everything, keeps a
      // current content record's lazily-cached blob, and makes the echo of our own
      // commit free — which matters on every cycle now, not only after a failed one:
      // the cursor no longer skips our commits, so each one is listed back once.
      //
      // Content paths already at their entry's stamp are settled first, without being
      // read (contentAtStamp) — the echo of a content push names exactly the records
      // that hold their megabytes.
      const settled = await contentAtStamp(entries.filter((e) => isContentPath(e.path)));
      const unsettled = entries.filter((e) => !settled.has(e.path));
      const locals = await db.items.bulkGet(unsettled.map((e) => e.path));
      const stale = unsettled.filter((e, i) => {
        const local = locals[i];
        if (!local || local.updatedAt < e.updatedAt) return true;
        return !isContentPath(e.path) && !local.data;
      });

      const content = stale.filter((e) => isContentPath(e.path));
      const index = stale.filter((e) => !isContentPath(e.path));

      // toItemRecord is the single projector that derives the queryable `item*`
      // columns from the decrypted bytes (data/projection.ts) — the engine stays
      // schema-blind, it just routes every write through it so the indexes can't
      // drift from `data`. A content record carries no bytes here, so it projects
      // none (only its `itemType`/`updatedAt`) — which is exactly why this one must go
      // through the guarded put too: landing it on a path whose bytes are still queued
      // would strip them, and the drain would then find nothing to upload.
      //
      // The whole content set rides ONE transaction: nothing awaits the network
      // between these records, so there's no reason to open a transaction per row (the
      // index records can't do the same — each waits on its own GET).
      await putPulled(
        deps.username,
        content.map((e) => toItemRecord(e.path, e.updatedAt)),
      );

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
// (BlobUnreadableError — tampered, sealed for another path, from a build before
// the path binding, or corrupt). Skipped, not thrown: one such path used to
// reject the pull, so the cycle failed with the cursor where it was and met the
// same blob on every cycle after — no path in the account synced again. Skipped,
// the entry is treated like the 404 above: nothing stored, the counter ticks, the
// cursor moves on, and a local copy the path already had stays as it was. The
// path is read again only when it is rewritten or a fallback lists it
// (docs/local-first-sync.md, _crypto boundary_). Anything else still throws —
// an unknown format version above all, which an update fixes. The batch content
// fetch (loadEntityContents) opens through here too, for the same reason.
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

// Which of these CONTENT entries the store already holds at exactly the entry's
// stamp — answered off the `updatedAt` index's key cursor, so no record is
// deserialized. A content record's `data` is the cached blob itself, megabytes of
// it, and the staleness test wants one number; reading a batch of records to
// compare stamps would pull every cached page copy in the batch into memory at
// once, for an echo that changes nothing. (The fallback's reconcile reads its
// stamps the same way, for the same reason.) Exact match only: a path the store
// holds at some OTHER stamp is left to the full comparison, which is what tells
// "newer here" from "newer there".
async function contentAtStamp(entries: Entry[]): Promise<Set<string>> {
  const settled = new Set<string>();
  if (entries.length === 0) return settled;
  const stampOf = new Map(entries.map((e) => [e.path, e.updatedAt]));
  await db.items
    .where('updatedAt')
    .anyOf([...new Set(stampOf.values())])
    .eachKey((updatedAt, cursor) => {
      const path = cursor.primaryKey as string;
      if (stampOf.get(path) === updatedAt) settled.add(path);
    });
  return settled;
}

// Store pulled records, skipping any path the local queue now holds an op for —
// the reconcile's local-wins test (docs/local-first-sync.md — a sync cycle), re-taken
// at write time and inside the write's own transaction, for the same reason
// applyDeletes re-takes it: the callers filtered against the `pending` SNAPSHOT read
// at the top of the cycle, and this device keeps writing through the round trips that
// follow. Without it a mid-cycle edit is silently overwritten by the server copy it
// was meant to beat — and the pending op survives, so the next drain uploads the
// SERVER's bytes back, laundering the loss into a legitimate-looking commit.
//
// Per record, not per batch, because each index record arrives after its own network
// GET: batching the puts would mean holding a whole chunk's decrypted blobs in memory
// and would cost the resumability of storing each one the moment it's decrypted.
// A pending DELETE counts too: local-wins means a queued deletion isn't resurrected
// by the pull that raced it.
//
// It also re-checks that this account still owns the store (AccountFencedError,
// sync-store.ts), inside the same transaction: a cycle that outlived a sign-out or
// an account switch in any tab must not write the old account's plaintext into the
// new store.
async function putPulled(username: string, records: ItemRecord[]): Promise<void> {
  if (records.length === 0) return;
  await db.transaction('rw', db.items, db.pendingOps, db.syncMeta, async () => {
    await assertAccountStillOwnsStore(username);
    const ops = await db.pendingOps.bulkGet(
      records.map((r) => [username, r.path] as [string, string]),
    );
    const writable = records.filter((_, i) => ops[i] === undefined);
    if (writable.length > 0) await db.items.bulkPut(writable);
  });
}

// Drop the local records the reconcile judged deleted server-side — RE-TESTING the
// pending queue at apply time, inside the delete's own transaction.
//
// Both callers already excluded pending paths, but from the `pending` SNAPSHOT read at
// the top of the cycle, and a cycle is many network round trips long. A local write that
// lands DURING it (the extension's active-tab extraction writing `extractions/{id}.enc`
// while the save's own cycle is still listing, the web app's user typing) is local-only
// and absent from that snapshot, so the fallback's "local only, not in pending-ops" row
// (docs/local-first-sync.md — fallback full sync) matched a brand-new create and deleted
// it — while its pending op, written in the same transaction, survived. That op is then
// UNPUSHABLE FOREVER: uploadBlobs finds no bytes, the commit answers `no_object`, and
// `no_object` deliberately leaves the path queued to retry. The queue wedges at a
// permanent non-zero count that no amount of syncing drains, and the entity (an
// extraction, so a link silently missing its title/image) is gone with it.
//
// The re-read has to share the delete's transaction to actually close the window:
// IndexedDB serializes overlapping rw transactions on these stores, so a concurrent
// writeBytesWith either commits FIRST (its pending op is visible here → the path is
// spared) or AFTER (this delete hits the stale record, and its put re-creates it). Both
// orders end with the local write intact.
//
// Fenced on the account's bookkeeping row like putPulled — a stale cycle's deletes
// would otherwise land in the next account's store.
async function applyDeletes(username: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await trace.span('deletes.apply', () => applyDeletesTx(username, paths), {
    paths: paths.length,
  });
}

async function applyDeletesTx(username: string, paths: string[]): Promise<void> {
  await db.transaction('rw', db.items, db.pendingOps, db.syncMeta, async () => {
    await assertAccountStillOwnsStore(username);
    const ops = await db.pendingOps.bulkGet(
      paths.map((path) => [username, path] as [string, string]),
    );
    const deletable = paths.filter((_, i) => ops[i] === undefined);
    if (deletable.length > 0) await db.items.bulkDelete(deletable);
  });
}

// The local paths a full listing does not show: what a first sync's retry has to
// drop, by the fallback's "local only" row. Primary keys alone — no record is read.
// The caller hands these to applyDeletes, which spares any path with an op queued.
async function localOnlyPaths(files: Entry[]): Promise<string[]> {
  const listed = new Set(files.map((f) => f.path));
  const local = await db.items.toCollection().primaryKeys();
  return local.filter((path) => !listed.has(path));
}

// --- control-plane helpers --------------------------------------------------

// Page the full R2 listing (fallback + first sync). `pageToken` is R2's opaque
// cursor relayed straight back; loop until it comes back null. The listing is not a
// snapshot: pages span concurrent writes, and an object written into a key range
// already passed is simply absent. That is safe for what gets DOWNLOADED (every
// consumer compares `updatedAt`) and is exactly why the listing never supplies the
// CURSOR — both callers end on the log's high-water mark instead (logWatermark).
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
// Always asks for the api's blob route (`via: 'api'`): R2's S3 endpoint is
// HTTP/1.1, so a browser runs six of the fan-outs below at a time against it, and
// preflights every PUT; the api's host carries all of them on one HTTP/2 or
// HTTP/3 connection (docs/local-first-sync.md, _the blob route_). What comes back
// is self-describing — an `authorization` to send, or a presign that needs none —
// so an api that predates the field, and answers with presigns, still syncs.
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

// Route incremental vs. fallback from the op log's retained-range bounds (docs "the
// ops/list endpoint" routing table). A returning client always has a cursor here
// (incremental only runs post-first-sync), so an empty or out-of-range log means
// the log was wiped/compacted/reset beneath us — re-list R2.
function needsFallback(since: number, page: OpsListResponse): boolean {
  const { oldestUpdatedAt: oldest, newestUpdatedAt: newest } = page;
  if (newest === null) return true; // empty/wiped log under a returning client
  if (since > newest) return true; // cursor ahead — log was reset/restored
  if (oldest !== null && since < oldest) return true; // ops before the cursor were compacted
  return false; // oldest ≤ since ≤ newest — run the keyset query
}
