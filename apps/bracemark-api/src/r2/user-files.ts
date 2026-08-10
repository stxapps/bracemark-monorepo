import type { FilesListResponse, SignedUrl } from '@stxapps/shared';

import type { Bindings } from '../lib/env';
import { HttpError } from '../lib/errors';
import { stripUserPrefix, userFileKey, userPrefix } from './keys';
import { isLocalR2, localBlobUrl } from './local';
import { presignR2Url, type R2Credentials } from './presign';

// The access layer for the USER_FILES R2 bucket — the R2 analogue of db/'s
// repositories and the DO's repositories. Every read of the bucket and every
// presigned URL goes through here, so key-namespacing (keys.ts) and the S3
// presigner (presign.ts) are applied in ONE place, never re-inlined in a
// service, route, or the DO. See docs/local-first-sync.md.
//
// Unlike the D1/DO repos (which each take a single storage handle), this takes
// the whole `env`: R2's surface spans TWO bindings — the native bucket binding
// (USER_FILES, for list/head) AND the S3 credential vars (R2_*, for presigning;
// the binding can't mint browser-usable URLs). The factory holds both together.

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
    // absent. The op-commit existence check and the quota size source (see the put
    // branch of UserDataDO.commitOp).
    async head(userId: string, path: string): Promise<{ updatedAt: number; size: number } | null> {
      const object = await bucket.head(userFileKey(userId, path));
      if (!object) return null;
      return { updatedAt: object.uploaded.getTime(), size: object.size };
    },

    // Delete a user's objects — the server side of a committed `delete` op (the
    // client can't do it itself: files/sign mints only PUT/GET URLs). One bulk
    // binding call; deleting an absent key is a no-op, so a retried commit stays
    // idempotent. Callers stay within the contract's 1000-op batch cap, which
    // matches the binding's 1000-key bulk-delete ceiling.
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

    // Mint presigned URLs for the given wire-relative paths, each namespaced under
    // the caller's prefix here — so cross-user signing is structurally impossible
    // (the key can only resolve under `users/{userId}/`). Credentials are assembled
    // once for the whole batch; `method`/`expiresIn` are the caller's sync policy.
    async presignUrls(
      userId: string,
      paths: string[],
      method: 'PUT' | 'GET',
      expiresIn: number,
    ): Promise<SignedUrl[]> {
      // Local dev: miniflare's emulated R2 has no presignable S3 endpoint, so
      // mint URLs to the in-Worker blob proxy instead (r2/local.ts +
      // routes/local-r2.ts). No real R2 credentials needed — and `expiresIn` is
      // moot, the proxy doesn't enforce a TTL.
      if (isLocalR2(env)) {
        return paths.map((path) => ({ path, url: localBlobUrl(userFileKey(userId, path)) }));
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
