import type {
  BlobTransport,
  CommitFailure,
  CommitOp,
  FilesListResponse,
  OpsCommitResponse,
  SignedUrl,
  SignOp,
} from '@stxapps/shared';

import type { CommitEntry, OpLogFence } from '../do/user-data';
import { callUserData } from '../do/user-data';
import type { Bindings } from '../lib/env';
import { checkPutQuota } from '../lib/quota';
import { type Timer, untimed } from '../lib/server-timing';
import { readUploadReceipt, type UploadReceipt } from '../r2/upload-receipt';
import { type ObjectStat, userFilesRepo } from '../r2/user-files';
import { getQuotaCeilings } from './iap';

// Service layer for the sync endpoints. It holds the POLICY and the cross-store
// orchestration — TTLs, the quota gate, the op→method mapping, and the R2-then-DO
// commit handshake — delegating all R2 access to r2/user-files (the bucket
// gateway) and all op-log/size access to the per-user DO. ops/list is the one
// genuinely single-store endpoint (a pure DO keyset query), so it stays a direct
// DO passthrough in the route. See docs/local-first-sync.md.

// Signed-URL lifetimes, the same for a presign and a blob-route token. PUT URLs
// are short-lived (a commit follows immediately, so a few minutes covers
// retry/backoff); GET URLs live longer because first sync mints them in BATCH and
// the client streams downloads lazily over a session.
const PUT_URL_TTL_SECONDS = 5 * 60; // 5 minutes
const GET_URL_TTL_SECONDS = 60 * 60; // 1 hour

// Fallback full sync (GET /v1/files/list): ONE page of objects under the user's
// prefix with R2's own `LastModified` — the download-authoritative truth the
// client reconciles against. The client drives the paging via `pageToken`
// (opaque); the R2 calls, one per namespace per page, live in the bucket gateway.
export async function listUserFiles(
  env: Bindings,
  userId: string,
  pageToken: string | undefined,
  limit: number,
): Promise<FilesListResponse> {
  return userFilesRepo(env).listPage(userId, pageToken, limit);
}

// Mint signed URLs (POST /v1/files/sign). Paths arrive already shape-validated by
// the contract (syncPathSchema); the gateway namespaces each under the caller's
// prefix, so cross-user access is structurally impossible. `put` additionally
// clears the per-user quota at issuance (the only place abuse is boundable when
// content is opaque); `get` needs no quota (reading your own data), so download
// URLs batch freely.
//
// `via` picks where the bytes go — R2 directly over a presign, or the api's blob
// route over a token (@stxapps/shared sync/endpoints.ts, blobTransportSchema).
// Absent is `r2`, which is what every client shipped before the blob route
// sends, and what they keep getting. Both grant the same thing for the same
// time, so the gate above is the whole of the authorization either way.
//
// `requestUrl` is the caller's own request URL: the blob route's URL and the
// local-dev blob proxy's both name the origin the caller reached the api on
// (r2/user-files.ts blobUrls; r2/local.ts for why it can't be a constant). A
// presign names R2's S3 endpoint and ignores it.
export async function signUserFileUrls(
  env: Bindings,
  userId: string,
  op: SignOp,
  paths: string[],
  requestUrl: string,
  time: Timer = untimed,
  via: BlobTransport = 'r2',
): Promise<SignedUrl[]> {
  let fence: OpLogFence | undefined;
  if (op === 'put') {
    // The put gate is a plan-aware COST BACKSTOP — byte and object ceilings from
    // the shared entitlements table, applied by checkPutQuota (lib/quota.ts). It
    // does not count links: the free tier's cap is client-side now, and
    // lib/quota.ts's header carries why. The ceilings come from the account's
    // HIGH-WATER plan, not its current one (services/iap.ts foldQuotaCeilings),
    // so a lapsed subscription never makes an already-uploaded library
    // unwritable — the one reason this reads ceilings rather than entitlements.
    //
    // Two independent reads — one DO RPC and one D1 read — so fetch in parallel.
    // Note the check needs nothing about `paths` beyond the fact that this is a
    // put: it compares CURRENT usage against the ceilings, which is what freed
    // this path from the per-batch existence check it used to make.
    //
    // The same DO call answers the op log's fence, which every blob-route PUT
    // token carries into the upload receipt its PUT answers with (do/user-data.ts
    // putGate, r2/upload-receipt.ts). Read here, BEFORE any of the batch's PUTs
    // can land, which is what makes it a fence: every delete the commit has to
    // know about is appended after it.
    const [gate, ceilings] = await Promise.all([
      time('do-usage', () => callUserData(env, userId, (stub) => stub.putGate())),
      time('d1-ceilings', () => getQuotaCeilings(env, userId)),
    ]);
    checkPutQuota(ceilings, gate.usage);
    fence = gate.fence;
  }

  const method = op === 'put' ? 'PUT' : 'GET';
  const expiresIn = op === 'put' ? PUT_URL_TTL_SECONDS : GET_URL_TTL_SECONDS;

  const repo = userFilesRepo(env);
  return time('presign', () =>
    via === 'api'
      ? repo.blobUrls(userId, paths, method, expiresIn, requestUrl, fence)
      : repo.presignUrls(userId, paths, method, expiresIn, requestUrl),
  );
}

// Record committed mutations (POST /v1/ops/commit) — the R2-first, log-last
// handshake, batched. Every `put` is resolved to R2's authoritative
// `LastModified` + size, which the DO stores as the op's cursor clock and quota
// entry, and resolving it is also the existence check upholding the
// op-without-object invariant. Two ways to resolve one:
//
//   - FROM ITS UPLOAD RECEIPT, when it carries one this api can trust
//     (r2/upload-receipt.ts): the blob route's signed record of R2's answer to
//     the PUT. No R2 call at all — which is the point: the check below grows
//     with the user's library, not the commit's size, and a 500-edit commit on
//     a 10,000-link library spent 13.4 s in it (docs/local-first-sync.md,
//     _upload receipts_). The receipt proves the object landed, not that it is
//     still there; the DO's fence checks the gap against the log (do/user-data.ts
//     commitOps, THE FENCE).
//   - FROM R2, for every put without one — a presigned PUT, a client or a token
//     from before receipts, a receipt that is expired, malformed or another
//     user's — exactly as before receipts: a listing per run of keys where the
//     batch is dense, a HEAD per path where it is sparse (r2/user-files.ts
//     statMany, which says why a HEAD per put stopped being enough).
//
// A `put` whose object is MISSING is not logged (that would 404 every puller) but
// is reported in `failed` with reason 'no_object', so the client gets an explicit
// per-path outcome and re-PUTs + re-commits. A `delete` has no surviving object to
// check, so it's stamped on the worker's commit clock and the path's recorded size
// is freed. A single DO RPC then writes every surviving entry (one round trip to
// the user's serialized SQLite) — or, when the fence turns a receipt down, writes
// NOTHING and names the stale paths, and the batch is resolved again with every
// receipted put checked against R2 and written by a second RPC that carries no
// receipts, so it always lands. `results` + `failed` together account for every
// op sent.
//
// The R2 object of every `delete` is removed HERE, server-side — files/sign mints
// only PUT/GET URLs, so the client never DELETEs R2 directly. R2 first, log last,
// the same direction as puts: a commit that dies between the two leaves an absent
// object with no op — invisible to incremental pull, healed by the fallback — and
// a retried delete is a no-op. One bulk binding call keeps the delete-metadata-
// first window the client's op ordering asks for negligible.
export async function commitOps(
  env: Bindings,
  userId: string,
  ops: CommitOp[],
  time: Timer = untimed,
): Promise<OpsCommitResponse> {
  const repo = userFilesRepo(env);
  const now = Date.now();

  const deletes = ops.filter((o) => o.op === 'delete').map((o) => o.path);
  await time('r2-delete', () => repo.deleteMany(userId, deletes));

  const receipts = await readReceipts(env, userId, ops, now);
  // `r2-stat` is the existence check's wall time; `r2-list` and `r2-head` beside
  // it are the sums of the calls it made (lib/server-timing.ts). A commit whose
  // every put carried a receipt checks nothing, and reads ~0.
  const unreceipted = ops.filter((o) => o.op === 'put' && !receipts.has(o.path)).map((o) => o.path);
  const objects = await time('r2-stat', () => repo.statMany(userId, unreceipted, { time }));

  const first = resolveOps(ops, now, objects, receipts);
  if (first.entries.length === 0) return { results: [], failed: first.failed };
  const { results, stale } = await time('do-commit', () =>
    callUserData(env, userId, (stub) => stub.commitOps(first.entries)),
  );
  if (stale.length === 0) return { results, failed: first.failed };

  // The fence turned at least one receipt down — a delete of its path, or a wipe,
  // landed since its token was signed — and the DO wrote none of the batch. Check
  // every receipted put against R2, as if none had a receipt, and commit the
  // batch again: without fences it cannot be turned down twice.
  const rechecked = await time('r2-stat', () =>
    repo.statMany(userId, [...receipts.keys()], { time }),
  );
  for (const [path, stat] of rechecked) objects.set(path, stat);
  const second = resolveOps(ops, now, objects, new Map());
  if (second.entries.length === 0) return { results: [], failed: second.failed };
  const retried = await time('do-commit', () =>
    callUserData(env, userId, (stub) => stub.commitOps(second.entries)),
  );
  return { results: retried.results, failed: second.failed };
}

// The upload receipts in a commit that this api can trust, by path. One the api
// cannot read is left out, and its put is checked against R2 like any other: a
// receipt is a shortcut and never the reason a commit fails (r2/upload-receipt.ts).
async function readReceipts(
  env: Bindings,
  userId: string,
  ops: CommitOp[],
  now: number,
): Promise<Map<string, UploadReceipt>> {
  const receipts = new Map<string, UploadReceipt>();
  const secret = env.R2_SECRET_ACCESS_KEY;
  if (!secret) return receipts;
  await Promise.all(
    ops.map(async ({ op, path, receipt }) => {
      if (op !== 'put' || !receipt) return;
      const read = await readUploadReceipt(secret, receipt, { userId, path }, now);
      if (read) receipts.set(path, read);
    }),
  );
  return receipts;
}

// Each op as the DO records it, or as the `failed` entry it becomes. A receipted
// put takes its facts and its fence from the receipt; any other put takes them
// from `objects`, and is `no_object` without one.
function resolveOps(
  ops: CommitOp[],
  now: number,
  objects: Map<string, ObjectStat>,
  receipts: Map<string, UploadReceipt>,
): { entries: CommitEntry[]; failed: CommitFailure[] } {
  const entries: CommitEntry[] = [];
  const failed: CommitFailure[] = [];
  for (const { op, path } of ops) {
    if (op === 'delete') {
      entries.push({ op, path, updatedAt: now, size: 0 });
      continue;
    }
    const receipt = receipts.get(path);
    if (receipt) {
      const { updatedAt, size, fence } = receipt;
      entries.push({ op, path, updatedAt, size, fence });
      continue;
    }
    const object = objects.get(path);
    if (!object) {
      failed.push({ path, reason: 'no_object' }); // op-without-object invariant
      continue;
    }
    entries.push({ op, path, updatedAt: object.updatedAt, size: object.size });
  }
  return { entries, failed };
}

// Wipe the user's whole data plane (POST /v1/data/delete-all; also step one of
// account deletion — services/account.ts). Two halves, and the ORDER is the
// op-without-object invariant read in the delete direction:
//
//   1. DO first — clear the op log + quota map (one wipeAll RPC). With the log
//      empty, no op can point at an object the next step removes; a crash
//      between the halves leaves only objects-without-ops, which the R2-listing
//      fallback heals (vs. the reverse order, where surviving put-ops would 404
//      every puller). The emptied log is also the multi-device signal: returning
//      clients route into the download-authoritative fallback and reconcile
//      against the empty namespace — no new sync machinery.
//   2. R2 second — delete every object under the user's prefix, paged.
//
// Idempotent end to end (both halves no-op on empty), so a failure anywhere is
// safely retried by just calling again. Returns the R2 delete count — the
// client's receipt line.
export async function deleteAllUserData(
  env: Bindings,
  userId: string,
): Promise<{ deletedCount: number }> {
  await callUserData(env, userId, (stub) => stub.wipeAll());
  const deletedCount = await userFilesRepo(env).deleteAllForUser(userId);
  return { deletedCount };
}
