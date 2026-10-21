import {
  type FileEntry,
  type FilesListResponse,
  ID_KEYED_PREFIXES,
  SETTINGS_PREFIX,
  type SignedUrl,
} from '@stxapps/shared';

import type { Bindings } from '../lib/env';
import { HttpError } from '../lib/errors';
import { type Timer, untimed } from '../lib/server-timing';
import { stripUserPrefix, userFileKey, userPrefix } from './keys';
import { isLocalR2, localBlobUrl } from './local';
import { presignR2Url, type R2Credentials } from './presign';

// The access layer for the USER_FILES R2 bucket — the R2 analogue of db/'s
// repositories and the DO's repositories. Every call on the bucket and every R2
// presign goes through here, so key-namespacing (keys.ts) and the S3 presigner
// (presign.ts) are applied in ONE place, never re-inlined in a service, route,
// or the DO. See docs/local-first-sync.md.
//
// What belongs here is what needs the bucket or an object's KEY. The api's own
// credentials — the blob route's tokens (blob-token.ts) and upload receipts
// (upload-receipt.ts) — need neither: they bind a user id and a wire path under
// an HMAC, so they are pure functions of the secret, minted and read by the
// sync service (services/sync.ts) and checked by the blob route.
//
// Unlike the D1/DO repos (which each take a single storage handle), this takes
// the whole `env`: R2's surface spans TWO bindings — the native bucket binding
// (USER_FILES, for list/head and the blob route's bytes) AND the S3 credential
// vars (R2_*, for presigning). The factory holds both together.

// The object facts a commit records for a put: R2's `LastModified` as the op's
// stamp, and its size for the quota map.
export type ObjectStat = { updatedAt: number; size: number };

// statMany's two strategies, and where it switches between them (see there).
// Below HEAD_ONLY_BELOW keys a commit HEADs outright: a few rounds of HEADs are
// as fast as a listing, and a handful of edits is the common commit.
//
// LIST_MIN_HITS is set by PRICE, not speed. A listing is an R2 Class A operation
// ($4.50 / M) and a HEAD is Class B ($0.36 / M), so one page costs what 12.5
// HEADs do: a page that answers fewer than 13 keys was the dearer way to answer
// them, and the rest of that namespace is HEADed instead. On speed alone a page
// would win from 7 keys up (HEADs run six at a time, the Workers connection
// limit) — so at 13 a listing is never slower and never costlier. What a wrong
// guess costs is one page per namespace per commit. Tune against `r2-list` /
// `r2-head` in a commit's Server-Timing, and against R2's price list if it moves.
const HEAD_ONLY_BELOW = 12;
const LIST_MIN_HITS = 13;
const LIST_PAGE = 1000;

// The facts a commit records for a put, as R2 reports them on any of its
// answers about one object — a HEAD, a listing's entry, a PUT.
function statOf(object: R2Object | null): ObjectStat | null {
  return object ? { updatedAt: object.uploaded.getTime(), size: object.size } : null;
}

// Assemble the R2 S3 credentials, failing loudly if a deploy is missing one — a
// misconfigured signer must not silently hand out unusable URLs.
function r2Credentials(env: Bindings): R2Credentials {
  const { R2_ACCOUNT_ID, R2_USER_FILES_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!R2_ACCOUNT_ID || !R2_USER_FILES_BUCKET || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new HttpError(500, 'r2_unconfigured', 'R2 signing credentials are not configured');
  }
  return {
    accountId: R2_ACCOUNT_ID,
    bucket: R2_USER_FILES_BUCKET,
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  };
}

// The namespaces a first listing page asks for outright, beside the bucket's own
// answer to which exist (listPage).
const LISTED_NAMESPACES: readonly string[] = [...ID_KEYED_PREFIXES, SETTINGS_PREFIX];

// One namespace still to list, and R2's cursor into it (null: not started).
type SplitCursor = [ns: string, cursor: string | null];

// A split listing's page token: its unfinished namespaces and their cursors,
// marked so it is told apart from R2's own cursor — which is what a token from
// before the split is, and what wholePrefixPage resumes. R2's cursor is opaque;
// the mark is one no cursor has been seen to start with, and the cost of a
// collision would be one 400 and a listing started again.
const SPLIT_TOKEN_MARK = '~ns1~';
// A namespace as a token may name it: one segment of the path charset and its
// slash. Checked on the way back in, so a token names nothing but a namespace
// under the caller's own prefix; a bucket prefix outside it is never put in one
// (listPage lists such an account the old way instead).
const NAMESPACE_RE = /^[A-Za-z0-9_-]+\/$/;

function isSplitToken(token: string): boolean {
  return token.startsWith(SPLIT_TOKEN_MARK);
}

function encodeSplitToken(pending: readonly SplitCursor[]): string {
  const json = JSON.stringify(pending);
  const base64 = btoa(json).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return SPLIT_TOKEN_MARK + base64;
}

function decodeSplitToken(token: string): SplitCursor[] {
  const invalid = () =>
    new HttpError(400, 'invalid_page_token', 'Unreadable files/list page token');
  let parsed: unknown;
  try {
    const base64 = token.slice(SPLIT_TOKEN_MARK.length).replaceAll('-', '+').replaceAll('_', '/');
    parsed = JSON.parse(atob(base64));
  } catch {
    throw invalid();
  }
  const valid =
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    parsed.every(
      (entry: unknown) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        NAMESPACE_RE.test(entry[0]) &&
        (entry[1] === null || typeof entry[1] === 'string'),
    );
  if (!valid) throw invalid();
  return parsed as SplitCursor[];
}

// A listing's objects as wire entries. Defensive: list({ prefix }) only returns
// keys under the user's prefix, so a non-match shouldn't occur — it is skipped
// rather than served as a malformed path.
function entriesOf(userId: string, objects: readonly R2Object[]): FileEntry[] {
  const out: FileEntry[] = [];
  for (const object of objects) {
    const path = stripUserPrefix(userId, object.key);
    if (path !== null) out.push({ path, updatedAt: object.uploaded.getTime() });
  }
  return out;
}

// R2 refusing a call for now: `We encountered an internal error. Please try
// again. (10001)`. On staging, 2026-10-19, the binding answered 7 of ~14,000
// blob-route PUTs in a 10,000-link push that way. Matched on the code in the
// message, which is all the binding's error carries.
const R2_INTERNAL_ERROR = /\(10001\)/;

export function isR2InternalError(err: unknown): boolean {
  return err instanceof Error && R2_INTERNAL_ERROR.test(err.message);
}

// Run `call` again, once, when R2 refused it with a 10001 — in the Worker, before
// the route answers 5xx, so the retry costs the client nothing and reaches every
// client version, old ones included (docs/local-first-sync.md, _retrying a
// failure_, on the server). Only for a call that can be made twice: a read, or a
// write whose body is in memory. A streamed body is spent by the first attempt,
// and is the client's to retry (its L1).
async function onceMoreOnInternalError<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!isR2InternalError(err)) throw err;
    return call();
  }
}

export function userFilesRepo(env: Bindings) {
  const bucket = env.USER_FILES;

  const head = async (userId: string, path: string): Promise<ObjectStat | null> =>
    statOf(await bucket.head(userFileKey(userId, path)));

  // The listing as it was before the split: one page of the whole prefix in key
  // order, with R2's own cursor as the token. For a token minted that way, and
  // for a prefix holding more than a page of namespaces (listPage).
  const wholePrefixPage = async (
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<FilesListResponse> => {
    const page = await bucket.list({ prefix: userPrefix(userId), cursor, limit });
    return {
      files: entriesOf(userId, page.objects),
      nextPageToken: page.truncated ? page.cursor : null,
    };
  };

  return {
    // ONE page of the per-user prefix as wire-relative paths with R2's own
    // LastModified — the fallback full sync (GET /v1/files/list) the client
    // reconciles against. The client drives the paging with an opaque
    // `pageToken`; `nextPageToken` is null once every namespace is listed.
    //
    // EACH NAMESPACE IS LISTED ON ITS OWN, ALL OF THEM AT ONCE. R2 caps a list
    // call at 1000 keys and walks one prefix in key order, so the whole prefix
    // as one listing was a page per call, one after another: 40 pages, 78 s, for
    // a 10,000-link account on staging (docs/local-first-sync.md, _measuring a
    // sync_). A page here is a call per namespace still unfinished, run
    // together, and the token carries each one's cursor (encodeSplitToken) — so a
    // page can hold up to `limit` keys PER NAMESPACE, and an account is about as
    // many pages as its largest namespace needs.
    //
    // ⚠ WHICH NAMESPACES IS READ FROM THE BUCKET, not from the list this
    // server was built with. The listing is download-AUTHORITATIVE: a client
    // drops a local path the listing lacks. A namespace missing from it — one a
    // newer client writes before this server knows its name — would be deleted
    // from every device that took a fallback, silently. So the first page also
    // asks R2 for the prefixes that exist (`delimiter`), beside the known
    // namespaces' first pages, and anything it finds that is not known is listed
    // on the pages after. A key directly under the user's prefix comes back
    // with it, as it did in the whole-prefix listing. Should the user's prefix
    // ever hold more than a page of prefixes, or one a token may not name
    // (NAMESPACE_RE), the listing is taken the old way.
    //
    // A token minted before the split is R2's own cursor over the whole prefix,
    // and a client paging across the deploy still holds one: it is finished the
    // old way (`wholePrefixPage`), and the next listing starts split.
    async listPage(
      userId: string,
      pageToken: string | undefined,
      limit: number,
    ): Promise<FilesListResponse> {
      if (pageToken !== undefined && !isSplitToken(pageToken)) {
        return wholePrefixPage(userId, pageToken, limit);
      }

      const root = userPrefix(userId);
      const files: FileEntry[] = [];
      const pending: SplitCursor[] = [];
      const listInto = async (namespaces: readonly SplitCursor[]) => {
        const pages = await Promise.all(
          namespaces.map(([ns, cursor]) =>
            bucket.list({ prefix: root + ns, cursor: cursor ?? undefined, limit }),
          ),
        );
        pages.forEach((page, i) => {
          files.push(...entriesOf(userId, page.objects));
          if (page.truncated) pending.push([namespaces[i][0], page.cursor]);
        });
      };

      if (pageToken === undefined) {
        const known = LISTED_NAMESPACES.map((ns): SplitCursor => [ns, null]);
        const [top] = await Promise.all([
          bucket.list({ prefix: root, delimiter: '/' }),
          listInto(known),
        ]);
        if (top.truncated) return wholePrefixPage(userId, undefined, limit);
        files.push(...entriesOf(userId, top.objects));
        const found = top.delimitedPrefixes.map((prefix) => prefix.slice(root.length));
        if (!found.every((ns) => NAMESPACE_RE.test(ns))) {
          return wholePrefixPage(userId, undefined, limit);
        }
        for (const ns of found) {
          if (!LISTED_NAMESPACES.includes(ns)) pending.push([ns, null]);
        }
      } else {
        await listInto(decodeSplitToken(pageToken));
      }

      return { files, nextPageToken: pending.length > 0 ? encodeSplitToken(pending) : null };
    },

    // HEAD a user's object: R2's LastModified (as `updatedAt`) + `size`, or null if
    // absent. One path's answer to the question statMany answers for a batch.
    head,

    // The commit's existence check for a whole batch: path → R2's LastModified +
    // size for every path that has an object; a path absent from the map has none.
    // The same facts a HEAD per path reads, from the same strongly-consistent
    // bucket, so the op-without-object invariant holds exactly as it did.
    //
    // WHY NOT A HEAD PER PATH, which is what this replaced: a Worker invocation
    // runs at most six outgoing calls at once that are waiting on their response
    // headers, and a HEAD is nothing but headers, so a 500-op commit's HEADs ran
    // six at a time — 25.6 s per full index chunk on staging, a fifth of a
    // 1,000-link push (docs/local-first-sync.md, _measuring a sync_). A LISTING
    // answers up to a thousand keys in one call. R2 lists in key order, so a
    // batch sorted by key is walked page by page from its first unanswered key
    // (`startAfter`), and a page answers every batch key up to its last key:
    // listed means present, unlisted means absent.
    //
    // Dense batches — an import, a first push — are what this is for: their keys
    // are most of their namespace, and a page answers hundreds. A sparse batch —
    // a few edits among thirty thousand links — gets a page that answers one, so
    // statMany HEADs instead (HEAD_ONLY_BELOW, LIST_MIN_HITS above). Each
    // namespace is walked on its own (a page never spans two), and the namespaces
    // concurrently.
    //
    // The call count stays inside the MAX_COMMIT_OPS budget it was sized for (one
    // per op, @stxapps/shared sync/endpoints.ts): every page before the switch
    // answered at least LIST_MIN_HITS keys, so the worst case is the HEADs plus
    // a thirteenth as many pages, plus one per namespace. The same bound holds the
    // R2 bill to at most one wasted page per namespace over a HEAD per put.
    //
    // `pageSize` exists for the specs, which cannot afford a thousand objects per
    // page boundary; every caller leaves it at R2's maximum.
    async statMany(
      userId: string,
      paths: string[],
      { time = untimed, pageSize = LIST_PAGE }: { time?: Timer; pageSize?: number } = {},
    ): Promise<Map<string, ObjectStat>> {
      const found = new Map<string, ObjectStat>();
      const headAll = (list: string[]) =>
        Promise.all(
          list.map(async (path) => {
            const stat = await time('r2-head', () => head(userId, path));
            if (stat) found.set(path, stat);
          }),
        );

      const wanted = new Set(paths);
      const unique = [...wanted];
      if (unique.length < HEAD_ONLY_BELOW) {
        await headAll(unique);
        return found;
      }

      // Grouped by namespace, each group's keys sorted the way R2 orders keys
      // (UTF-8 bytes; every key here is ASCII, so code-unit order is the same).
      const byNamespace = new Map<string, string[]>();
      for (const path of unique) {
        const ns = path.slice(0, path.indexOf('/') + 1);
        const list = byNamespace.get(ns);
        if (list) list.push(path);
        else byNamespace.set(ns, [path]);
      }

      await Promise.all(
        [...byNamespace].map(async ([ns, list]) => {
          const prefix = userPrefix(userId) + ns;
          const keys = list.map((path) => userFileKey(userId, path)).sort();
          let i = 0;
          while (i < keys.length) {
            // `startAfter` is exclusive, so start after the key with its last
            // character dropped: that sorts just below the key, and no valid key
            // sits between the two (every key ends in `.enc`).
            const page = await time('r2-list', () =>
              bucket.list({ prefix, startAfter: keys[i].slice(0, -1), limit: pageSize }),
            );
            // A page lists the batch's neighbours too; only the batch is answered.
            for (const object of page.objects) {
              const path = stripUserPrefix(userId, object.key);
              if (path !== null && wanted.has(path)) {
                found.set(path, { updatedAt: object.uploaded.getTime(), size: object.size });
              }
            }
            // A truncated page answers keys up to its last; a final page, all the
            // rest. A page that answered too few hands the rest to HEADs — which is
            // also what guarantees the walk ends, since every page that doesn't
            // switch moved `i` forward.
            const last = page.objects.at(-1)?.key;
            const start = i;
            while (
              i < keys.length &&
              (!page.truncated || (last !== undefined && keys[i] <= last))
            ) {
              i++;
            }
            if (i < keys.length && i - start < LIST_MIN_HITS) {
              await headAll(keys.slice(i).map((key) => key.slice(userPrefix(userId).length)));
              return;
            }
          }
        }),
      );
      return found;
    },

    // Delete a user's objects — the server side of a committed `delete` op (the
    // client can't do it itself: files/sign mints only PUT/GET URLs). One bulk
    // binding call; deleting an absent key is a no-op, so a retried commit stays
    // idempotent. Callers stay within the contract's MAX_COMMIT_OPS batch cap,
    // which sits under the binding's 1000-key bulk-delete ceiling.
    async deleteMany(userId: string, paths: string[]): Promise<void> {
      if (paths.length === 0) return;
      await bucket.delete(paths.map((path) => userFileKey(userId, path)));
    },

    // Delete EVERYTHING under the user's prefix — the R2 half of delete-all-data
    // (and of account deletion). Loops list()+delete() in 1000-key pages (each is
    // one subrequest, so even a 100k-object library stays ~200 subrequests, well
    // inside one Worker invocation). Lists WITHOUT a cursor each pass — deleting a
    // page invalidates any cursor into the listing, and re-listing from the top
    // just returns the next surviving keys. Raw keys straight to delete(), no
    // stripUserPrefix round-trip: everything under the prefix goes, including a
    // malformed key a path-validating caller could never name. Returns the count
    // deleted (the client's receipt). Idempotent — an empty prefix deletes 0.
    async deleteAllForUser(userId: string): Promise<number> {
      const prefix = userPrefix(userId);
      let deletedCount = 0;
      for (;;) {
        const page = await bucket.list({ prefix, limit: 1000 });
        if (page.objects.length === 0) return deletedCount;
        await bucket.delete(page.objects.map((object) => object.key));
        deletedCount += page.objects.length;
        if (!page.truncated) return deletedCount;
      }
    },

    // The blob route's two transfers (routes/blob.ts; a PUT by way of
    // services/sync.ts putBlob), by the grant a verified token carries. The
    // bytes are ciphertext either way: the route moves them, never reads them.
    // `get` answers null for an absent object, and is asked twice when R2
    // refuses it with a 10001.
    get(userId: string, path: string): Promise<R2ObjectBody | null> {
      return onceMoreOnInternalError(() => bucket.get(userFileKey(userId, path)));
    },

    // `body` must have a known length — R2 refuses a stream that doesn't — which
    // a request body declaring a Content-Length has. A body that declares none
    // is read whole and written with putBytes (services/sync.ts putBlob).
    //
    // Both answer the object R2 just wrote, as the facts a commit records for it
    // (the same `uploaded` and `size` a HEAD or a listing reads back) — what
    // putBlob signs into the PUT's upload receipt (upload-receipt.ts). Null only
    // where R2 wrote nothing, which an unconditional put never answers.
    //
    // Only `putBytes` is asked twice on a 10001: its body is in memory. A stream
    // is consumed by the attempt that failed, so `put` leaves the retry to the
    // client, which still holds the sealed bytes.
    async put(userId: string, path: string, body: ReadableStream): Promise<ObjectStat | null> {
      return statOf(await bucket.put(userFileKey(userId, path), body));
    },

    async putBytes(userId: string, path: string, body: ArrayBuffer): Promise<ObjectStat | null> {
      return statOf(
        await onceMoreOnInternalError(() => bucket.put(userFileKey(userId, path), body)),
      );
    },

    // Mint presigned URLs for the given wire-relative paths, each namespaced under
    // the caller's prefix here — so cross-user signing is structurally impossible
    // (the key can only resolve under `users/{userId}/`). Credentials are assembled
    // once for the whole batch; `method`/`expiresIn` are the caller's sync policy.
    //
    // `requestUrl` is the incoming request's own URL, and it is used ONLY by the
    // local-dev branch below, which has to name an origin the caller can reach.
    // It is required rather than defaulted precisely because the wrong default is
    // invisible — see r2/local.ts.
    async presignUrls(
      userId: string,
      paths: string[],
      method: 'PUT' | 'GET',
      expiresIn: number,
      requestUrl: string,
    ): Promise<SignedUrl[]> {
      // Local dev: miniflare's emulated R2 has no presignable S3 endpoint, so
      // mint URLs to the in-Worker blob proxy instead (r2/local.ts +
      // routes/local-r2.ts). No real R2 credentials needed — and `expiresIn` is
      // moot, the proxy doesn't enforce a TTL.
      if (isLocalR2(env)) {
        return paths.map((path) => ({
          path,
          url: localBlobUrl(userFileKey(userId, path), requestUrl),
        }));
      }

      const creds = r2Credentials(env);
      return Promise.all(
        paths.map(async (path) => ({
          path,
          url: await presignR2Url(creds, { key: userFileKey(userId, path), method, expiresIn }),
        })),
      );
    },
  };
}
