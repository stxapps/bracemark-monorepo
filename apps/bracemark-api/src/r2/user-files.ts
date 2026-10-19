import { BLOB_PATH, type FilesListResponse, type SignedUrl } from '@stxapps/shared';

import type { Bindings } from '../lib/env';
import { HttpError } from '../lib/errors';
import { type Timer, untimed } from '../lib/server-timing';
import { BLOB_AUTH_SCHEME, type BlobMethod, mintBlobToken } from './blob-token';
import { stripUserPrefix, userFileKey, userPrefix } from './keys';
import { isLocalR2, localBlobUrl } from './local';
import { presignR2Url, type R2Credentials } from './presign';

// The access layer for the USER_FILES R2 bucket — the R2 analogue of db/'s
// repositories and the DO's repositories. Every read of the bucket and every
// signed URL goes through here, so key-namespacing (keys.ts), the S3 presigner
// (presign.ts) and the blob route's tokens (blob-token.ts) are applied in ONE
// place, never re-inlined in a service, route, or the DO. See
// docs/local-first-sync.md.
//
// Unlike the D1/DO repos (which each take a single storage handle), this takes
// the whole `env`: R2's surface spans TWO bindings — the native bucket binding
// (USER_FILES, for list/head and the blob route's bytes) AND the S3 credential
// vars (R2_*, for presigning, and the root the blob tokens' key is derived from).
// The factory holds both together.

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

export function userFilesRepo(env: Bindings) {
  const bucket = env.USER_FILES;

  const head = async (userId: string, path: string): Promise<ObjectStat | null> => {
    const object = await bucket.head(userFileKey(userId, path));
    if (!object) return null;
    return { updatedAt: object.uploaded.getTime(), size: object.size };
  };

  return {
    // ONE page of the per-user prefix as wire-relative paths with R2's own
    // LastModified — the fallback full sync (GET /v1/files/list) the client
    // reconciles against. The client drives the paging: `pageToken` is R2's own
    // list cursor passed straight through (opaque), and `nextPageToken` is R2's
    // cursor when the page is truncated, else null. R2 caps a list at 1000 keys,
    // so the caller's `limit` rides that same ceiling.
    async listPage(
      userId: string,
      pageToken: string | undefined,
      limit: number,
    ): Promise<FilesListResponse> {
      const prefix = userPrefix(userId);
      const page = await bucket.list({ prefix, cursor: pageToken, limit });
      const files = [];

      for (const object of page.objects) {
        const path = stripUserPrefix(userId, object.key);
        // Defensive: list({ prefix }) only returns keys under the prefix, so a
        // non-match shouldn't occur — skip rather than serve a malformed path.
        if (path === null) continue;
        files.push({ path, updatedAt: object.uploaded.getTime() });
      }

      return { files, nextPageToken: page.truncated ? page.cursor : null };
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

    // Mint blob-route URLs for the given wire-relative paths: the api's own
    // `BLOB_PATH` on the origin the caller reached it at, and a token per path
    // (blob-token.ts) for the request's `Authorization` header. The URL is the
    // same for every path — the token names the object — so a browser asks one
    // CORS preflight for the route rather than one per blob.
    //
    // The origin is ECHOED from the request, for the reason localBlobUrl's is
    // (r2/local.ts): one `wrangler dev` answers on localhost and on the Mac's LAN
    // address at once. Off `wrangler dev` it is safe for a narrower reason — a
    // request only reaches this Worker on a hostname routed to it
    // (wrangler.jsonc `routes`), so the echo can only ever name this api.
    //
    // Local dev mints these too, signed with the placeholder secret: the blob
    // route works against miniflare's bucket exactly as against R2's, so a local
    // run exercises the path a deployed client takes.
    async blobUrls(
      userId: string,
      paths: string[],
      method: BlobMethod,
      expiresIn: number,
      requestUrl: string,
    ): Promise<SignedUrl[]> {
      const secret = env.R2_SECRET_ACCESS_KEY;
      if (!secret) {
        throw new HttpError(500, 'r2_unconfigured', 'R2 signing credentials are not configured');
      }
      const url = `${new URL(requestUrl).origin}${BLOB_PATH}`;
      return Promise.all(
        paths.map(async (path) => ({
          path,
          url,
          authorization: `${BLOB_AUTH_SCHEME} ${await mintBlobToken(secret, {
            userId,
            path,
            method,
            expiresIn,
          })}`,
        })),
      );
    },

    // The blob route's two transfers (routes/blob.ts), by the grant a verified
    // token carries. The bytes are ciphertext either way: the route moves them,
    // never reads them. `get` answers null for an absent object.
    get(userId: string, path: string): Promise<R2ObjectBody | null> {
      return bucket.get(userFileKey(userId, path));
    },

    // `body` must have a known length — R2 refuses a stream that doesn't — which
    // a request body declaring a Content-Length has. The route reads a body that
    // declares none whole and writes it with putBytes (routes/blob.ts).
    async put(userId: string, path: string, body: ReadableStream): Promise<void> {
      await bucket.put(userFileKey(userId, path), body);
    },

    async putBytes(userId: string, path: string, body: ArrayBuffer): Promise<void> {
      await bucket.put(userFileKey(userId, path), body);
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
