'use client';

// Hand-rolled sync engine — layer 2 in docs/local-first-sync.md. Runs at the
// app/background level, NOT in React (no hooks): it drives the four-endpoint
// control plane through the shared contract client (`api.call`, which is
// `callEndpoint` bound to bracemark-api's baseUrl with the bearer token attached) and
// moves blob bytes to/from R2 over presigned URLs, doing the crypto boundary
// (encrypt before PUT / decrypt after GET) with @stxapps/web-crypto. Decrypted
// results land in the Dexie store (db.ts), which the UI observes reactively.
//
// R2 is the source of truth; the op log is a disposable accelerator (the doc's
// central invariant). So every flow can fall back to listing R2 and lose nothing
// but speed, and the cursor is R2's `LastModified` — the compound key
// `(updatedAt, path)` — never the op log's internal `seq`.

import {
  type ApiClient,
  apiErrorCode,
  chunk,
  type CommitResult,
  emptySyncOutcome,
  FILES_PREFIX,
  filesListEndpoint,
  filesSignEndpoint,
  mapLimit,
  MAX_COMMIT_OPS,
  MAX_LIST_LIMIT,
  MAX_SIGN_PATHS,
  type OpEntry,
  opsCommitEndpoint,
  opsListEndpoint,
  type OpsListResponse,
  recordBlocked,
  type SignOp,
  type SyncOutcome,
  withRetry,
} from '@stxapps/shared';
import { decryptEntity, encryptEntity } from '@stxapps/web-crypto';

import { db, type ItemRecord, type PendingOpRecord } from '../data/db';
import { clearDrainedOps, listPendingOps } from '../data/pending-store';
import { toItemRecord } from '../data/projection';
import { advanceCursor, getSyncMeta, markFirstSyncDone, resetCursor } from '../data/sync-store';
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
// (anything ≤ the cap is valid; fewer round trips wins). A client-only knob, not
// contract.
const SIGN_BATCH = MAX_SIGN_PATHS;
const COMMIT_BATCH = MAX_COMMIT_OPS;
const OPS_PAGE = MAX_LIST_LIMIT;
const FILES_PAGE = MAX_LIST_LIMIT;

// Blob fan-out, split by direction because the two workloads bind on opposite
// resources (a bounded cap also keeps a first sync of thousands of files from
// opening thousands of sockets at once). Downloads are small index blobs (KB) over
// HTTP/2 and RTT-bound, so a wide fan-out cuts first-sync time and drains the
// presigned GET URLs sooner. Uploads can be MB-sized `files/` content, bound by
// uplink bandwidth + memory (peak ≈ concurrency × blob size), so they stay modest.
// Starting points — tune against a measured large first sync.
const DOWNLOAD_CONCURRENCY = 24;
const UPLOAD_CONCURRENCY = 8;

// One put-pipeline pass (pushPuts) signs, uploads, and commits a single chunk, so
// the chunk must fit BOTH the sign cap and the commit cap in one call each. Both are
// 1000 today; min() stays correct if they ever diverge. Bounding the chunk this way
// keeps each presigned PUT URL's mint-to-PUT latency inside its own chunk's upload
// window — for KB-sized index blobs that is well under the 5-min TTL on any push. A
// `files/` content chunk CAN outlive the TTL on a slow uplink; that is absorbed per
// blob, not per chunk: an expired-URL PUT fails only its own op (uploadBlobs), the
// chunk still commits the blobs that landed, and the rest retry next cycle under
// fresh URLs — monotonic progress either way, never a livelock.
const PUT_BATCH = Math.min(SIGN_BATCH, COMMIT_BATCH);

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
  return { ...deps, api: withRetry(deps.api) };
}

// --- public flows -----------------------------------------------------------

// First sync after a fresh sign-in on this device (docs flow #1). List the full R2
// manifest, download + decrypt the index, build the local store — content is NOT
// pulled here. BLOCKING from the UI's point of view (InitialSyncGate shows the
// decrypting screen until this resolves).
export async function runInitialSync(deps: SyncDeps): Promise<void> {
  deps = withRetryDeps(deps);
  const files = await listAllFiles(deps.api);
  await storeDownloads(deps, files);
  // Cursor is the newest compound `(updatedAt, path)` among ALL listed files
  // (content included, even though its blob is deferred) — the same
  // reconstruction the fallback cycle does from its full listing.
  const newest = newestCursor(files);
  await markFirstSyncDone(deps.username, newest.updatedAt, newest.path);
}

// Single-flight per account. Overlapping calls (the post-ready background pull, an
// edit-triggered requestSync, a retry) coalesce: a caller during a run shares the
// in-flight promise, and at most one trailing rerun picks up whatever changed
// after that run's snapshot. Serializing cycles keeps two drains from
// double-committing the same pending ops and keeps cursor writes ordered within
// this tab; across tabs, advanceCursor's forward-only guard covers the rest.
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

async function incrementalSyncOnce(deps: SyncDeps): Promise<SyncOutcome> {
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
  const pending = await listPendingOps(deps.username);

  // Peek the first page: its retained-range bounds decide incremental vs. fallback
  // before we commit to paging the op log.
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

  const url = (await signPaths(withRetry(deps.api), 'get', [path])).get(path);
  if (!url) return undefined;

  const blob = await getBlob(url).catch((err: unknown) => {
    if (err instanceof BlobRequestError && err.status === 404) return undefined;
    throw err;
  });
  if (!blob) return undefined;

  const data = await decryptEntity(deps.encryptionKey, blob);
  // Cache under a compare-and-set on the stamp read at the top: a sync pull can
  // restamp this path mid-fetch (newer `updatedAt`, cached `data` dropped), and
  // landing the older blob under the new stamp would serve stale content FOREVER —
  // the engine's staleness skip only re-downloads when the server stamp moves
  // again. Losing the race just skips the cache: the caller still gets the bytes
  // it asked for, and the next call fetches the newer version.
  await db.transaction('rw', db.items, async () => {
    const current = await db.items.get(path);
    if (current?.updatedAt === rec.updatedAt) await db.items.update(path, { data });
  });
  return data;
}

// Batch counterpart of loadEntityContent, for a caller that needs MANY `files/`
// blobs resident at once (the export flow's download phase). Same semantics per
// path — fetch, decrypt, persist into the local store so re-runs are resumable
// and offline reads work — but signed in SIGN_BATCH pages (one `files/sign` call
// per ~1000 paths instead of one per file) and fetched at the engine's download
// fan-out. Already-resident bytes are skipped (and don't count toward progress);
// a path that's unknown locally or 404s on GET (deleted on another device, the
// delete op not yet pulled) lands in `missingPaths` for the caller to report —
// never a thrown error, mirroring loadEntityContent. Any other failure rejects.
export async function loadEntityContents(
  deps: SyncDeps,
  paths: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ missingPaths: string[] }> {
  deps = withRetryDeps(deps);

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
  for (const batch of chunk(wanted, SIGN_BATCH)) {
    const urls = await signPaths(deps.api, 'get', batch);
    await mapLimit(batch, DOWNLOAD_CONCURRENCY, async (path) => {
      const url = urls.get(path);
      const blob = url
        ? await getBlob(url).catch((err: unknown) => {
          if (err instanceof BlobRequestError && err.status === 404) return undefined;
          throw err;
        })
        : undefined;
      if (blob) {
        const data = await decryptEntity(deps.encryptionKey, blob);
        await db.transaction('rw', db.items, async () => {
          const current = await db.items.get(path);
          if (current?.updatedAt === baseStamps.get(path)) await db.items.update(path, { data });
        });
      } else {
        missingPaths.push(path);
      }
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
  for (; ;) {
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
  const { committed, orphanedPaths } = await pushPending(deps, pending, outcome);
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
// R2 listing (docs "fallback full sync"). The server list is truth for every path
// WITHOUT a pending local op — so a server-side deletion is never resurrected and
// a stale leftover is dropped. A pending op is a genuine unsynced local intent,
// resolved exactly as the incremental cycle resolves it — local-wins — so a
// fallback (an infra event: log wiped/compacted/reset) never silently flips a
// conflict to server-wins: a pending edit is pushed over the server copy, and a
// pending delete is pushed rather than resurrected by the listing.
async function fallbackCycle(
  deps: SyncDeps,
  pending: PendingOpRecord[],
  outcome: SyncOutcome,
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
// committed results (R2's authoritative clock) so the caller can advance its cursor
// over its own writes, plus the paths of ops the self-heal dropped (uploadBlobs) so
// the caller can re-add their server copies to its download set. Removes each
// committed path from the queue; a `no_object` failure is left queued to re-PUT
// next drain.
//
// Runs in the global phase order [delete-metadata, delete-content, put-content,
// put-metadata] — the mirror pair of the multi-file-consistency rules (docs
// "multi-file consistency"): a create writes content before the metadata that
// references it; a delete removes that metadata before the content it referenced.
// So no crash or partial push ever leaves metadata pointing at a missing content
// file. Crucially each PHASE commits durably before the next, and each CHUNK within
// the put phases signs + uploads + commits as one unit (pushPuts) — so a presigned
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
): Promise<{ committed: CommitResult[]; orphanedPaths: string[] }> {
  if (ops.length === 0) return { committed: [], orphanedPaths: [] };

  const puts = ops.filter((o) => o.op === 'put');
  const deletes = ops.filter((o) => o.op === 'delete');
  const committed: CommitResult[] = [];
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
  committed.push(
    ...(await commitBatched(deps, [
      ...deletes.filter((o) => !isContentPath(o.path)),
      ...deletes.filter((o) => isContentPath(o.path)),
    ])),
  );

  // Phase 3 then 4: drain ALL content puts (every chunk) before ANY metadata put, so
  // the content-before-metadata invariant holds across chunk boundaries too.
  committed.push(
    ...(await pushPuts(
      deps,
      puts.filter((o) => isContentPath(o.path)),
      outcome,
      orphanedPaths,
      failures,
    )),
  );
  // A content upload that failed left its op queued — so the metadata phase (which
  // may reference that content) is HELD this cycle, or a puller could land metadata
  // whose content 404s: the exact breach the phase order exists to prevent. Held
  // wholesale because the engine is schema-blind — it can't tell which metadata is
  // safe. The held ops just stay queued; the next drain retries both halves in order.
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

// Drive a homogeneous put set (all content OR all metadata — the caller splits and
// orders them) through the sign → PUT → commit pipeline one chunk at a time, so each
// chunk's PUT URLs are minted immediately before that chunk's upload and the chunk
// commits before the next is signed. PUT_BATCH fits one sign and one commit call, so
// each stays a single round trip.
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
    // know we didn't send — on a big failed chunk that's up to a thousand doomed
    // entries per cycle — and the failure is already surfaced through `failures`.
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
// branch is gone with the cap itself: it is enforced on the create surfaces now,
// so an over-cap link is refused before it is ever
// written and never becomes a pending op.
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

// Commit a sequence of ops in input order, chunked under the commit cap — batches go
// out sequentially, so the caller's phase ordering is preserved across chunks. For
// each committed put, stamp R2's authoritative `updatedAt` onto the local record (a
// delete has no record left to stamp — update is a no-op), then clear the ops it
// accepted. `failed` (only `no_object` today) is intentionally ignored: leaving the
// path queued is exactly the retry.
//
// The clear takes the OP ROWS this drain read, not the committed paths, so it removes
// only the writes it actually pushed (clearDrainedOps): an edit made during the push
// sits at the same path under a new `writeId` and must outlive this commit — its bytes
// are not the bytes that just went up. The restamp is unconditional even then: R2 does
// hold that path at `r.updatedAt` now, and the surviving op keeps its own older base,
// which local-wins reconcile never reads against it.
async function commitBatched(deps: SyncDeps, ops: PendingOpRecord[]): Promise<CommitResult[]> {
  const committed: CommitResult[] = [];
  for (const batch of chunk(ops, COMMIT_BATCH)) {
    const { results } = await deps.api.call(opsCommitEndpoint, {
      ops: batch.map((o) => ({ op: o.op, path: o.path })),
    });
    committed.push(...results);
    // All of a batch's restamps share one rw transaction — update() per result
    // opened a transaction each, which made a 1000-op commit pay a thousand IDB
    // round trips for what is one logical write. update() still no-ops per row
    // when the record is gone (a committed delete has nothing to stamp).
    await db.transaction('rw', db.items, async () => {
      for (const r of results) await db.items.update(r.path, { updatedAt: r.updatedAt });
    });
    const accepted = new Set(results.map((r) => r.path));
    await clearDrainedOps(batch.filter((o) => accepted.has(o.path)));
  }
  return committed;
}

// Encrypt and PUT each op's local blob to its signed URL. Sorts the ops it could
// not move into two buckets the caller treats differently, because the three
// skip shapes look alike and are not:
//
//  - `orphaned` — no local record, or a record stripped of its bytes. TERMINAL: a
//    write puts the record and enqueues its op in one transaction
//    (data/mutations.ts writeBytesWith), so an op without bytes is never a write
//    that hasn't landed yet — it is a record that went missing underneath a queued
//    op, and nothing will ever put those bytes back. Retrying is a permanent
//    wedge (the pending count sticks above zero forever), so the caller drops it.
//    Since applyDeletes stopped producing that state it should be unreachable; it
//    stays as the self-heal for queues already wedged by it, because a queue that
//    can't drain is invisible to every other repair.
//  - `failed` — the PUT itself threw (network blip, an expired presigned URL on a
//    chunk that outlived the TTL). TRANSIENT: the op stays queued and re-signs
//    next drain; recorded on `failures` so the cycle still rejects after the
//    phases instead of reporting a false 'idle'. Caught per op, so one bad blob
//    no longer aborts its whole chunk before the chunk could commit anything —
//    which on a chunk too big for one TTL window was a deterministic livelock.
//  - an unsigned path (no URL came back): also transient — leaving it queued IS
//    the retry, and the commit's `no_object` is the honest report.
async function uploadBlobs(
  deps: SyncDeps,
  ops: PendingOpRecord[],
  urls: Map<string, string>,
  failures: UploadFailures,
): Promise<{ orphaned: PendingOpRecord[]; failed: PendingOpRecord[] }> {
  const orphaned: PendingOpRecord[] = [];
  const failed: PendingOpRecord[] = [];
  await mapLimit(ops, UPLOAD_CONCURRENCY, async (op) => {
    const rec = await db.items.get(op.path);
    if (!rec?.data) {
      orphaned.push(op);
      return;
    }

    const url = urls.get(op.path);
    if (!url) return;

    try {
      await putBlob(url, await encryptEntity(deps.encryptionKey, rec.data));
    } catch (err) {
      failed.push(op);
      failures.count += 1;
      failures.firstError ??= err;
    }
  });
  return { orphaned, failed };
}

// --- download / store / delete ----------------------------------------------

// Fetch, decrypt, and store a set of entries. Content (`files/`) records keep only
// their `updatedAt` — the blob stays lazy (and a CHANGED record drops any
// previously-cached `data` so a stale copy isn't served after an update). The index
// is pulled in chunks — each chunk signs its own GET URLs, then GETs + decrypts +
// stores at bounded concurrency — so the URL set never outgrows one batch.
async function storeDownloads(deps: SyncDeps, entries: Entry[]): Promise<void> {
  // Selective sync: drop the namespaces this client doesn't materialize before any
  // sign/GET work (the cursor is advanced by the caller from the full op/file set, so
  // skipping these downloads never strands it). A no-op for a full-sync client.
  const { pathFilter } = deps;
  if (pathFilter) entries = entries.filter((e) => pathFilter(e.path));
  if (entries.length === 0) return;

  // Skip paths whose local record is already current (same-or-newer server stamp,
  // with the decrypted bytes present for an index path). That makes a re-run of an
  // interrupted first sync RESUME instead of re-downloading everything, makes a
  // re-pulled echo of our own commit free, and keeps a current content record's
  // lazily-cached blob.
  const locals = await db.items.bulkGet(entries.map((e) => e.path));
  const stale = entries.filter((e, i) => {
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
  // The whole content set rides ONE transaction: nothing awaits the network between
  // these records, so there's no reason to open a transaction per row (the index
  // records below can't do the same — each waits on its own GET).
  await putPulled(
    deps.username,
    content.map((e) => toItemRecord(e.path, e.updatedAt)),
  );
  // Index: sign → GET → decrypt → store one chunk at a time, so the presigned-URL
  // map never grows past a single batch (a large first sync holds ~1k URLs, not all
  // of them) and each URL's mint-to-GET latency stays well inside its 1-hour TTL.
  // Each record is stored the moment it's decrypted, so an interrupted run resumes
  // via the staleness skip above (fresh URLs for the shrinking remainder) rather
  // than restarting.
  for (const batch of chunk(index, SIGN_BATCH)) {
    const urls = await signPaths(
      deps.api,
      'get',
      batch.map((e) => e.path),
    );
    await mapLimit(batch, DOWNLOAD_CONCURRENCY, async (e) => {
      const url = urls.get(e.path);
      if (!url) return;

      const blob = await getBlob(url).catch((err: unknown) => {
        // Deleted between the op pull / listing and this GET: the delete op sits
        // past our window and reconciles next sync — skip it, don't fail the cycle.
        if (err instanceof BlobRequestError && err.status === 404) return;
        throw err;
      });
      if (!blob) return;

      const data = await decryptEntity(deps.encryptionKey, blob);
      await putPulled(deps.username, [toItemRecord(e.path, e.updatedAt, data)]);
    });
  }
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
async function putPulled(username: string, records: ItemRecord[]): Promise<void> {
  if (records.length === 0) return;
  await db.transaction('rw', db.items, db.pendingOps, async () => {
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
async function applyDeletes(username: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await db.transaction('rw', db.items, db.pendingOps, async () => {
    const ops = await db.pendingOps.bulkGet(
      paths.map((path) => [username, path] as [string, string]),
    );
    const deletable = paths.filter((_, i) => ops[i] === undefined);
    if (deletable.length > 0) await db.items.bulkDelete(deletable);
  });
}

// --- control-plane helpers --------------------------------------------------

// Page the full R2 listing (fallback + first sync). `pageToken` is R2's opaque
// cursor relayed straight back; loop until it comes back null. The listing is not a
// snapshot — safe here because every consumer compares `updatedAt`.
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

// Mint presigned URLs for a set of paths, batched under the contract cap, returned
// as a path→url map. `get` needs no quota so it batches freely; `put` is
// quota-checked server-side at issuance.
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

// Keyset ordering on the compound cursor (updatedAt, path).
function isNewer(ts: number, path: string, curTs: number, curPath: string): boolean {
  return ts > curTs || (ts === curTs && path > curPath);
}

// Newest compound (updatedAt, path) across full-listing results — the cursor a
// download-authoritative flow (first sync, fallback) reconstructs. Taken over ALL
// entries, never just the last page: R2 lists in key order, not time order, so
// the newest can sit on any page. `(0, '')` for an empty account.
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
