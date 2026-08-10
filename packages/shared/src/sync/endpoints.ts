import { z } from 'zod';

import { API_V1, defineEndpoint } from '../api/endpoint';
import { ENC_SUFFIX, ID_KEYED_PREFIXES, SETTINGS_PREFIX } from './paths';

// Local-first sync endpoint contracts — the four-endpoint control plane the
// background sync engine drives (see docs/local-first-sync.md). Two endpoints per
// resource: `ops` (the per-user op log, the incremental-pull accelerator) and
// `files` (the R2 objects, the source of truth). The blob bytes never touch the
// API — clients PUT/GET R2 directly over a `files/sign` URL — so these endpoints
// only ever move metadata: paths, timestamps, and signed URLs.
//
// Defined once here in `shared` (the lowest layer), exactly like the auth
// contracts, so bracemark-api validates against the same schema every client builds
// its typed fetch from. See docs/api-contracts.md.

// A `put` (the object exists/changed) or `delete` (it's gone) op. Same kinds the
// op log records and the client applies (download for put, remove for delete).
export const opKindSchema = z.enum(['put', 'delete']);
export type OpKind = z.infer<typeof opKindSchema>;

// A path RELATIVE to the user's storage root — `links/{id}.enc`, `files/{id}.enc`,
// `tags/{id}.enc`, `lists/{id}.enc`, `pins/{id}.enc`, `extractions/{id}.enc`, or the
// fixed-name `settings/<concern>.enc`.
// The `/users/{uid}/` prefix that namespaces the R2 object is NEVER on the wire:
// the server derives it from the authenticated session and prepends it, so one
// user can't name another's path (the authorization check in docs/local-first-
// sync.md "authorization & quota" reduces to "validate the shape, then prefix").
// The id segment is the random-id family (links/files/tags/lists/pins/extractions)
// or a fixed lowercase concern name (settings) — both end in `.enc`. Anchored + a closed
// charset, so there is no path-separator or traversal sequence to smuggle a key
// outside the namespace.
//
// The regex is BUILT from the path contract (paths.ts) rather than re-listing the
// namespaces as literals: the id-keyed group comes straight from
// `ID_KEYED_PREFIXES`, so a namespace added there is validated here automatically
// and this server-side gate can't drift from storage. See paths.ts.
const RANDOM_ID = '[A-Za-z0-9_-]+'; // links/files/tags/lists/pins/extractions id segment
const CONCERN = '[a-z0-9-]+'; // settings/<concern> — fixed lowercase name
// Escape regex metacharacters so a prefix/suffix const is matched literally.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A prefix const carries a trailing '/'; drop it, the regex adds the separator.
const namespace = (prefix: string) => escapeRe(prefix.slice(0, -1));

const idKeyedGroup = ID_KEYED_PREFIXES.map(namespace).join('|');

export const syncPathSchema = z
  .string()
  .regex(
    new RegExp(
      `^(?:(?:${idKeyedGroup})\\/${RANDOM_ID}|${namespace(SETTINGS_PREFIX)}\\/${CONCERN})${escapeRe(ENC_SUFFIX)}$`,
    ),
    'expected a sync path like links/<id>.enc',
  );

// Contract caps, defined once so the server's validation and the client's
// batching/paging stay pinned to the same numbers (the sync engine batches its
// writes and pages its reads against these). The 1000s all trace to R2: one
// `list()` call returns at most 1000 keys, and the write caps match so one
// request never implies more than ~1000 R2 subrequests.
export const MAX_COMMIT_OPS = 1000;
export const MAX_SIGN_PATHS = 1000;
export const MAX_LIST_LIMIT = 1000;

// --- GET /v1/ops/list — incremental pull ------------------------------------

// The cursor is the compound key (updatedAt, path) — R2's `LastModified`, not a
// seq (see docs/local-first-sync.md "the ops/list endpoint"). Both halves go over
// the wire as query params: a single millisecond can hold more ops than `limit`,
// so the `path` tiebreak is what lets the client page past it. `sincePath` is
// absent only while the cursor is the seeded-new-account `(0, '')`; the server
// treats a missing `sincePath` as the low sentinel. `z.coerce` because query
// params arrive as strings on the server.
export const opsListRequestSchema = z.object({
  since: z.coerce.number().int().optional(),
  sincePath: syncPathSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(MAX_LIST_LIMIT),
});
export type OpsListRequest = z.infer<typeof opsListRequestSchema>;

// One op as it crosses the wire — never the internal `seq` (that orders ties and
// drives compaction inside the DO, but is meaningless to clients; see storage
// layout). `updatedAt` is R2's `LastModified` for a put, the deletion commit time
// for a delete.
export const opEntrySchema = z.object({
  op: opKindSchema,
  path: z.string(),
  updatedAt: z.number(),
});
export type OpEntry = z.infer<typeof opEntrySchema>;

// `oldestUpdatedAt` / `newestUpdatedAt` are the retained-range bounds the client
// routes on (incremental vs. fallback — see the routing table in the doc); both
// are `null` on a never-written/wiped log. `hasMore` drives keyset pagination:
// the client advances (since, sincePath) to the last op and pulls again while it's
// true.
export const opsListResponseSchema = z.object({
  ops: z.array(opEntrySchema),
  oldestUpdatedAt: z.number().nullable(),
  newestUpdatedAt: z.number().nullable(),
  hasMore: z.boolean(),
});
export type OpsListResponse = z.infer<typeof opsListResponseSchema>;

// GET /v1/ops/list?since=…&sincePath=…&limit=… → { ops, oldestUpdatedAt, newestUpdatedAt, hasMore }
export const opsListEndpoint = defineEndpoint({
  method: 'GET',
  path: `${API_V1}/ops/list`,
  request: opsListRequestSchema,
  response: opsListResponseSchema,
});

// --- POST /v1/ops/commit — record committed mutations -----------------------

// One mutation to record, sent AFTER its R2 PUT (for `put`) succeeds. Batched —
// the client drains its pending-ops queue in one round trip (a first-sync push is
// thousands of files), and the server fans the per-put HEADs out in parallel
// rather than paying a request each. Capped at 1000 (same bound as files/sign);
// over the cap the whole request 400s at the contract before any work runs — the
// abuse gate.
export const commitOpSchema = z.object({
  op: opKindSchema,
  path: syncPathSchema,
});
export type CommitOp = z.infer<typeof commitOpSchema>;

export const opsCommitRequestSchema = z.object({
  ops: z.array(commitOpSchema).min(1).max(MAX_COMMIT_OPS),
});
export type OpsCommitRequest = z.infer<typeof opsCommitRequestSchema>;

// One COMMITTED op: the path and the `updatedAt` the server stamped — R2's
// `LastModified` for a put (read via the commit HEAD), the deletion commit time
// for a delete. The client stores this as the path's `updatedAt`, advances its
// sync cursor to it (never the local clock), and clears the path from its
// pending-ops queue.
export const commitResultSchema = z.object({
  path: z.string(),
  updatedAt: z.number(),
});
export type CommitResult = z.infer<typeof commitResultSchema>;

// One op the server did NOT record, with the reason — so the client gets an
// explicit outcome per path rather than inferring failure from absence. `reason`
// is an enum, not a free string, so the client can branch:
//  - 'no_object' — the `put`'s R2 object is missing (its PUT never landed, or died
//    before this commit). Recording it would break the op-without-object invariant
//    (every puller would 404), so the server refuses it; the client re-PUTs + re-
//    commits. Commit is idempotent, so a retry costs at most one redundant download.
// (R2 conditional writes, when added, will introduce a 'stale' reason whose client
// action is re-PULL then retry — a different branch, which is why this is typed.)
export const commitFailureSchema = z.object({
  path: z.string(),
  reason: z.enum(['no_object']),
});
export type CommitFailure = z.infer<typeof commitFailureSchema>;

// `results` are the committed ops; `failed` are the ones refused, with a reason.
// Together they account for every op the client sent (a path in neither is a
// server bug the client can detect). `failed` is empty in the common case.
export const opsCommitResponseSchema = z.object({
  results: z.array(commitResultSchema),
  failed: z.array(commitFailureSchema),
});
export type OpsCommitResponse = z.infer<typeof opsCommitResponseSchema>;

// POST /v1/ops/commit → { results: [{ path, updatedAt }, …], failed: [{ path, reason }, …] }
export const opsCommitEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/ops/commit`,
  request: opsCommitRequestSchema,
  response: opsCommitResponseSchema,
});

// --- GET /v1/files/list — fallback full R2 listing --------------------------

// Paginated: the whole namespace can be thousands of objects, and each R2
// `list()` is one subrequest capped at 1000 keys, so the server can't safely
// stream it all in one Worker invocation. `pageToken` is OPAQUE — it's R2's own
// list cursor passed straight back; never parse it or treat it as a path. Absent
// on the first page. `limit` caps the page at R2's 1000-key ceiling.
export const filesListRequestSchema = z.object({
  pageToken: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(MAX_LIST_LIMIT),
});
export type FilesListRequest = z.infer<typeof filesListRequestSchema>;

// One R2 object as the fallback sees it: its relative `path` and R2's own
// `LastModified`. Using R2's clock (not a separately-minted timestamp) is what
// lets fallback recover a commit-died edit — the new bytes carry a fresh
// `LastModified` even though no op was recorded. See "fallback full sync".
export const fileEntrySchema = z.object({
  path: z.string(),
  updatedAt: z.number(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

// One page of the download-authoritative listing. `nextPageToken` is R2's cursor
// when the listing is truncated, else null. The client pages until it's null and
// sets the cursor to the newest `(updatedAt, path)` across ALL pages — R2 lists in key
// order, not time order, so the newest timestamp can sit on any page. The listing
// is NOT a snapshot (pages span concurrent writes), which is safe here because
// fallback is download-authoritative and `updatedAt`-compared — anything that
// changes mid-listing carries a fresh `LastModified` and is caught next sync.
export const filesListResponseSchema = z.object({
  files: z.array(fileEntrySchema),
  nextPageToken: z.string().nullable(),
});
export type FilesListResponse = z.infer<typeof filesListResponseSchema>;

// GET /v1/files/list?pageToken=…&limit=… → { files: [{ path, updatedAt }, …], nextPageToken }
export const filesListEndpoint = defineEndpoint({
  method: 'GET',
  path: `${API_V1}/files/list`,
  request: filesListRequestSchema,
  response: filesListResponseSchema,
});

// --- POST /v1/files/sign — mint presigned R2 URL(s) -------------------------

// `put` mints upload URLs (quota-checked at issuance — the only place abuse can be
// bounded when content is opaque); `get` mints download URLs (no quota — reading
// your own data — so they can be minted in batch for a fast first sync). Either
// way the server verifies every path is the caller's before signing.
export const signOpSchema = z.enum(['put', 'get']);
export type SignOp = z.infer<typeof signOpSchema>;

export const filesSignRequestSchema = z.object({
  op: signOpSchema,
  paths: z.array(syncPathSchema).min(1).max(MAX_SIGN_PATHS),
});
export type FilesSignRequest = z.infer<typeof filesSignRequestSchema>;

// Each requested path paired with its presigned URL, returned in request order.
// The client PUTs/GETs the blob bytes directly to `url` (R2), never through the
// API — `files/sign` is a thin envelope check, not a content gateway.
export const signedUrlSchema = z.object({
  path: z.string(),
  url: z.string(),
});
export type SignedUrl = z.infer<typeof signedUrlSchema>;

export const filesSignResponseSchema = z.object({
  urls: z.array(signedUrlSchema),
});
export type FilesSignResponse = z.infer<typeof filesSignResponseSchema>;

// POST /v1/files/sign → { urls: [{ path, url }, …] }
export const filesSignEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/files/sign`,
  request: filesSignRequestSchema,
  response: filesSignResponseSchema,
});
