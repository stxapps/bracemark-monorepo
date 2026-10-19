import { API_V1, defineEndpoint } from '../api/endpoint';
import { z } from '../zod';
import { ENC_SUFFIX, ID_KEYED_PREFIXES, PATH_ID_PATTERN, SETTINGS_PREFIX } from './paths';

// Local-first sync endpoint contracts — the four-endpoint control plane the
// background sync engine drives (see docs/local-first-sync.md). Two endpoints per
// resource: `ops` (the per-user op log, the incremental-pull accelerator) and
// `files` (the R2 objects, the source of truth). These endpoints only ever move
// metadata: paths, timestamps, and signed URLs. The blob bytes move over the URL
// `files/sign` mints — either straight to R2 (a presigned URL) or through the
// api's blob route (`BLOB_PATH`, below), which is the same bytes on a faster
// path, not a content gateway (docs/local-first-sync.md, _the blob route_).
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
// and this server-side gate can't drift from storage. The id segment is
// `PATH_ID_PATTERN`, defined there too, so the backup reader gates an archive's ids
// against the very charset this regex is built from. See paths.ts.
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
      `^(?:(?:${idKeyedGroup})\\/${PATH_ID_PATTERN}|${namespace(SETTINGS_PREFIX)}\\/${CONCERN})${escapeRe(ENC_SUFFIX)}$`,
    ),
    'expected a sync path like links/<id>.enc',
  );

// Contract caps, defined once so the server's validation and the client's
// batching/paging stay pinned to the same numbers (the sync engine batches its
// writes and pages its reads against these). The list caps and MAX_SIGN_PATHS
// trace to R2's 1000-key `list()` page; signing is local crypto, one subrequest
// for the whole batch whatever its size.
//
// MAX_COMMIT_OPS is the one cap that is a SUBREQUEST budget, and it is half of
// the others on purpose. A commit HEADs every put, one R2 binding call each, on
// top of the auth middleware's D1 read (and its renewal write), the bulk delete
// and the DO RPC — and Workers Free, which staging runs on, allows 1000 calls to
// Cloudflare services per invocation, all of those counted together. At 1000 ops
// the commit came to 1001+ and the last HEAD threw: a 500, every time, on every
// retry of the same chunk, with the client re-uploading the whole chunk first.
// Nothing local catches it — miniflare enforces no such limit, and production's
// plan allows 10,000. 500 keeps half the budget free for whatever the next
// middleware reads, and halves what a failed chunk costs to re-upload.
//
// Upload receipts (commitOpSchema) take a receipted put out of that check, but
// they do not raise the cap: a batch from a client without them, or one the
// receipt fence sends back to R2 whole, still spends the budget as above.
export const MAX_COMMIT_OPS = 500;
export const MAX_SIGN_PATHS = 1000;
export const MAX_LIST_LIMIT = 1000;

// --- GET /v1/ops/list — incremental pull ------------------------------------

// The cursor is the compound key (updatedAt, path) — R2's `LastModified`, not a
// seq (see docs/local-first-sync.md "the ops/list endpoint"). Both halves go over
// the wire as query params: a single millisecond can hold more ops than `limit`,
// so the `path` tiebreak is what lets the client page past it. `sincePath` is
// absent while the cursor has no path half: the seeded-new-account `(0, '')`, and
// the listing-built `(newestUpdatedAt, '')` a first sync or a fallback ends on.
// The server treats a missing `sincePath` as the low sentinel, so that pull
// includes every op at the `since` millisecond. `z.coerce` because query params
// arrive as strings on the server.
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
// are `null` on a never-written/wiped log. `newestUpdatedAt` is also the cursor a
// client ends a LISTING-built flow on, read before it lists R2 — sound because the
// commit clamp stamps every later op strictly above it (docs "the cursor is a
// claim"). `hasMore` drives keyset pagination: the client advances
// (since, sincePath) to the last op and pulls again while it's true.
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
// thousands of files), and the server checks the batch's puts against R2 in a few
// listings or parallel HEADs rather than a request each. Capped at MAX_COMMIT_OPS —
// 500, half of files/sign's, because those R2 calls spend the invocation's
// subrequest budget (the caps above); over the cap the whole request 400s at the
// contract before any work runs — the abuse gate.
//
// `receipt` is what the blob route answered this path's PUT with (bracemark-api
// r2/upload-receipt.ts): the api's own signed statement that the object landed,
// with R2's `LastModified` and size. A put that carries a valid one is recorded
// without asking R2 again, which is what kept a commit's time growing with the
// size of the library (docs/local-first-sync.md, _upload receipts_). OPAQUE to a
// client, which passes back exactly what it was given, and OPTIONAL: a presigned
// PUT has none, nor does a PUT answered by an api that predates receipts, and the
// server checks R2 for any put without a receipt it can trust — so it is never
// the reason a commit fails. Ignored on a `delete`.
//
// MAX_RECEIPT_LENGTH bounds a request field, not stored bytes (docs/data-limits.md):
// a receipt carries five integers and its MAC and binds the path without
// repeating it, so its length does not grow with the path's. A receipt at the
// integers' extremes is ~200 characters (pinned in the api's r2/upload-receipt
// spec), so the cap can never refuse a genuine one — a refusal would 400 the
// whole batch, on every retry.
export const MAX_RECEIPT_LENGTH = 512;

export const commitOpSchema = z.object({
  op: opKindSchema,
  path: syncPathSchema,
  receipt: z.string().max(MAX_RECEIPT_LENGTH).optional(),
});
export type CommitOp = z.infer<typeof commitOpSchema>;

export const opsCommitRequestSchema = z.object({
  ops: z.array(commitOpSchema).min(1).max(MAX_COMMIT_OPS),
});
export type OpsCommitRequest = z.infer<typeof opsCommitRequestSchema>;

// One COMMITTED op: the path and the `updatedAt` the server stamped — R2's
// `LastModified` for a put (from its upload receipt, or read from R2 at commit
// when it has none), the deletion commit time
// for a delete, either one lifted by the commit clamp when it would not otherwise
// sort above the log. The client stores this as the path's `updatedAt` (never the
// local clock) and clears the op from its pending-ops queue. It does NOT move its
// sync cursor to it: the stamp places this op in the log, and the cursor claims
// everything below a point has been read — which a client's own commit never
// shows (docs "the cursor is a claim").
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
// when the listing is truncated, else null. The client pages until it's null. The
// listing is NOT a snapshot (pages span concurrent writes, and an object written
// into a key range already listed is simply absent), which is safe for what gets
// downloaded — fallback is download-authoritative and `updatedAt`-compared — and
// is why the sync CURSOR is never taken from these stamps: the client ends on the
// op log's `newestUpdatedAt`, read before the first page, and whatever changed
// mid-listing is above that and comes back on the next pull.
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

// Where the bytes go. `r2` is a SigV4 presign of R2's S3 endpoint — the only
// answer before the blob route existed, and still the answer to a request that
// names no `via`, which is every client shipped before it. `api` is the blob
// route on this api (`BLOB_PATH`). The difference is a connection, not a format:
// R2's S3 endpoint speaks HTTP/1.1 only, so a browser gives it six sockets and a
// sync's 24-wide fan-out runs six at a time, each PUT behind its own CORS
// preflight; the api's host is HTTP/2 and HTTP/3, so the fan-out is real
// (docs/local-first-sync.md, _the blob route_).
//
// A REQUEST FOR `api` IS A PREFERENCE, NOT A CONTRACT. The answer is
// self-describing — an `api` URL carries `authorization`, a presigned one does
// not — so a client sends the header when it is there and nothing when it is not,
// and works against an api that predates the field (which strips it and presigns)
// as well as one that has it. Neither deploy order breaks a sync.
export const blobTransportSchema = z.enum(['r2', 'api']);
export type BlobTransport = z.infer<typeof blobTransportSchema>;

export const filesSignRequestSchema = z.object({
  op: signOpSchema,
  paths: z.array(syncPathSchema).min(1).max(MAX_SIGN_PATHS),
  // Absent = `r2`, the shape every shipped client sends.
  via: blobTransportSchema.optional(),
});
export type FilesSignRequest = z.infer<typeof filesSignRequestSchema>;

// Each requested path paired with its signed URL, returned in request order. The
// client PUTs/GETs the blob bytes to `url` and nowhere else.
//
// `authorization`, when present, means the URL is the api's blob route and this
// is its credential: sent as the `Authorization` header on a PUT and a native
// GET, and as the whole body of the POST a browser reads with (api
// routes/blob.ts says why). Never in the URL, because a URL is what the api's
// invocation log writes down whole, query string included (docs/api-contracts.md,
// _a GET's query string reaches the request log_). Absent, the URL is a presign
// and its signature is the credential.
export const signedUrlSchema = z.object({
  path: z.string(),
  url: z.string(),
  authorization: z.string().optional(),
});
export type SignedUrl = z.infer<typeof signedUrlSchema>;

export const filesSignResponseSchema = z.object({
  urls: z.array(signedUrlSchema),
});
export type FilesSignResponse = z.infer<typeof filesSignResponseSchema>;

// POST /v1/files/sign → { urls: [{ path, url, authorization? }, …] }
export const filesSignEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/files/sign`,
  request: filesSignRequestSchema,
  response: filesSignResponseSchema,
});

// --- PUT / POST / GET /v1/files/blob — the blob route -------------------------

// Not a contract: its body is the blob's ciphertext, not JSON, so there is no
// schema to define once. The route is mounted by hand (bracemark-api
// routes/blob.ts) and reached only through a URL `files/sign` minted with
// `via: 'api'`, which names it whole — a client never builds it. ONE path for
// every object, the object named by the token, so a browser's one PUT preflight
// is cached for the path rather than asked again per blob (api app.ts, `maxAge`),
// and the log line of a transfer names no object.
export const BLOB_PATH = `${API_V1}/files/blob`;

// What a blob-route PUT answers with: `{ "receipt": "…" }` as JSON, the receipt
// the commit takes back (commitOpSchema). Absent when the route had none to give
// — a token minted by an api that predates receipts — and never sent by R2's
// own endpoint, whose PUT answers with an empty body. So a client reads it with
// receiptOf and treats every other answer as "no receipt", never as a failed
// upload: the bytes landed either way, and a put without a receipt still commits.
export const blobPutResponseSchema = z.object({
  receipt: z.string().max(MAX_RECEIPT_LENGTH).optional(),
});
export type BlobPutResponse = z.infer<typeof blobPutResponseSchema>;

// The receipt in a 2xx PUT's body text, or undefined for anything that is not
// one: an empty body (R2, an older api), a body that is not JSON, or a receipt
// over the contract's cap, which the commit would refuse whole.
export function receiptOf(body: string): string | undefined {
  if (!body) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const result = blobPutResponseSchema.safeParse(parsed);
  return result.success ? result.data.receipt : undefined;
}
