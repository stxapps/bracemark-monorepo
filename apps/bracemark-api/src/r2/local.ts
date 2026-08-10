import type { Bindings } from '../lib/env';

// Local-dev R2 helpers, shared by the r2 gateway (r2/user-files.ts) and the dev
// blob proxy route (routes/local-r2.ts). Production moves blob bytes browser↔R2
// directly over a SigV4-presigned URL (r2/presign.ts) — but that URL points at
// R2's real S3 endpoint (`{accountId}.r2.cloudflarestorage.com`), and miniflare's
// emulated R2 has no such endpoint: locally the bucket is reachable ONLY through
// the `env.USER_FILES` binding. So under `wrangler dev`, files/sign hands out URLs
// to the proxy route instead, and the bytes pass THROUGH the Worker. All of this
// is gated on the placeholder R2_ACCOUNT_ID (the `development` env in
// wrangler.jsonc); staging/prod keep real presigning untouched.

// The wrangler.jsonc `development` env sets this placeholder account id; it's the
// signal that R2 is miniflare-emulated rather than real. Real envs carry a true
// Cloudflare account id.
const LOCAL_R2_PLACEHOLDER_ACCOUNT = 'local-account-id';

// Where the local Worker is reachable. wrangler dev pins port 8787 (wrangler.jsonc
// `dev.port`), and bracemark-web hardcodes the API at this origin
// (apps/bracemark-web/.env.development) — so it's also where the browser fetches blobs.
const LOCAL_BLOB_ORIGIN = 'http://localhost:8787';

// The URL path prefix the blob proxy serves under; the full namespaced R2 key
// follows. Shared so the URL builder here and the route's path pattern
// (routes/local-r2.ts) can't drift.
export const LOCAL_BLOB_PATH_PREFIX = '/v1/files/blob/';

// True when R2 is the local miniflare emulation (no real S3 endpoint to presign).
export function isLocalR2(env: Bindings | undefined): boolean {
  return env?.R2_ACCOUNT_ID === LOCAL_R2_PLACEHOLDER_ACCOUNT;
}

// A browser-fetchable URL for a full R2 key, pointing at the dev proxy route
// instead of R2's S3 endpoint. Segments are percent-encoded individually so the
// '/' key separators stay literal path separators (Hono decodes them back in the
// route's `:key{.+}` param).
export function localBlobUrl(key: string): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${LOCAL_BLOB_ORIGIN}${LOCAL_BLOB_PATH_PREFIX}${encoded}`;
}
