import type {
  CommitFailure,
  CommitOp,
  FilesListResponse,
  OpsCommitResponse,
  SignedUrl,
  SignOp,
} from '@stxapps/shared';

import type { CommitEntry } from '../do/user-data';
import { userDataStub } from '../do/user-data';
import type { Bindings } from '../lib/env';
import { checkPutQuota } from '../lib/quota';
import { userFilesRepo } from '../r2/user-files';
import { getEntitlements } from './iap';

// Service layer for the sync endpoints. It holds the POLICY and the cross-store
// orchestration — TTLs, the quota gate, the op→method mapping, and the R2-then-DO
// commit handshake — delegating all R2 access to r2/user-files (the bucket
// gateway) and all op-log/size access to the per-user DO. ops/list is the one
// genuinely single-store endpoint (a pure DO keyset query), so it stays a direct
// DO passthrough in the route. See docs/local-first-sync.md.

// Presigned-URL lifetimes. PUT URLs are short-lived (a commit follows immediately,
// so a few minutes covers retry/backoff); GET URLs live longer because first sync
// mints them in BATCH and the client streams downloads lazily over a session.
const PUT_URL_TTL_SECONDS = 5 * 60; // 5 minutes
const GET_URL_TTL_SECONDS = 60 * 60; // 1 hour

// Fallback full sync (GET /v1/files/list): ONE page of objects under the user's
// prefix with R2's own `LastModified` — the download-authoritative truth the
// client reconciles against. The client drives the paging via `pageToken` (R2's
// opaque list cursor); the R2 call lives in the bucket gateway.
export async function listUserFiles(
  env: Bindings,
  userId: string,
  pageToken: string | undefined,
  limit: number,
): Promise<FilesListResponse> {
  return userFilesRepo(env).listPage(userId, pageToken, limit);
}

// Mint presigned R2 URLs (POST /v1/files/sign). Paths arrive already shape-
// validated by the contract (syncPathSchema); the gateway namespaces each under
// the caller's prefix, so cross-user access is structurally impossible. `put`
// additionally clears the per-user quota at issuance (the only place abuse is
// boundable when content is opaque); `get` needs no quota (reading your own
// data), so download URLs batch freely.
export async function signUserFileUrls(
  env: Bindings,
  userId: string,
  op: SignOp,
  paths: string[],
): Promise<SignedUrl[]> {
  if (op === 'put') {
    // The put gate is a plan-aware COST BACKSTOP — byte and object ceilings from
    // the account's entitlements (services/iap.ts → the shared entitlementsOf),
    // applied by checkPutQuota (lib/quota.ts). It does not count links: the free
    // tier's cap is client-side now, and lib/quota.ts's header carries why.
    //
    // Two independent reads — one DO RPC and one D1 read — so fetch in parallel.
    // Note the check needs nothing about `paths` beyond the fact that this is a
    // put: it compares CURRENT usage against the ceilings, which is what freed
    // this path from the per-batch existence check it used to make.
    const [usage, entitlements] = await Promise.all([
      userDataStub(env, userId).usage(),
      getEntitlements(env, userId),
    ]);
    checkPutQuota(entitlements, usage);
  }

  const method = op === 'put' ? 'PUT' : 'GET';
  const expiresIn = op === 'put' ? PUT_URL_TTL_SECONDS : GET_URL_TTL_SECONDS;

  return userFilesRepo(env).presignUrls(userId, paths, method, expiresIn);
}

// Record committed mutations (POST /v1/ops/commit) — the R2-first, log-last
// handshake, batched. For each `put` we HEAD R2: that doubles as the existence
// check upholding the op-without-object invariant and reads R2's authoritative
// `LastModified` + size, which the DO stores as the op's cursor clock and quota
// entry. The HEADs fan out in parallel — the win of batching. A `put` whose
// object is MISSING is not logged (that would 404 every puller) but is reported in
// `failed` with reason 'no_object', so the client gets an explicit per-path
// outcome and re-PUTs + re-commits. A `delete` has no surviving object to HEAD, so
// it's stamped on the worker's commit clock and the path's recorded size is freed.
// A single DO RPC then writes every surviving entry (one round trip to the user's
// serialized SQLite). `results` + `failed` together account for every op sent.
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
): Promise<OpsCommitResponse> {
  const repo = userFilesRepo(env);
  const now = Date.now();

  await repo.deleteMany(
    userId,
    ops.filter((o) => o.op === 'delete').map((o) => o.path),
  );

  const resolved = await Promise.all(
    ops.map(async ({ op, path }): Promise<CommitEntry | CommitFailure> => {
      if (op === 'delete') return { op, path, updatedAt: now, size: 0 };

      const object = await repo.head(userId, path);
      if (!object) return { path, reason: 'no_object' }; // op-without-object invariant

      return { op, path, updatedAt: object.updatedAt, size: object.size };
    }),
  );

  const entries: CommitEntry[] = [];
  const failed: CommitFailure[] = [];
  for (const r of resolved) {
    if ('reason' in r) failed.push(r);
    else entries.push(r);
  }

  if (entries.length === 0) return { results: [], failed };

  const { results } = await userDataStub(env, userId).commitOps(entries);
  return { results, failed };
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
  await userDataStub(env, userId).wipeAll();
  const deletedCount = await userFilesRepo(env).deleteAllForUser(userId);
  return { deletedCount };
}
