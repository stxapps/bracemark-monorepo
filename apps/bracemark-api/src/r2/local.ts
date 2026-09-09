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
//
// ⚠ The origin is ECHOED FROM THE CALLER'S OWN REQUEST (`c.req.url`), never a
// constant. `wrangler dev` binds 0.0.0.0 (wrangler.jsonc `dev.ip`), so ONE local
// Worker answers on several origins at once — `http://localhost:8787` from this
// Mac's browser and from an Android device via `adb reverse`, and
// `http://<mac-lan-ip>:8787` from a physical iPhone, which has no way to be told
// that localhost means the Mac (docs/device-testing.md, _the two ways in_).
// A hardcoded `localhost` here is correct for every caller except that phone, and
// on the phone it resolves to the PHONE: sync mints URLs happily, then every blob
// PUT/GET fails with a connection refused that reads as "the api is down" — no
// lint error, no type error, and every spec still passes, because the test runner
// and the simulator are on loopback like everything else. Echoing the request
// origin also keeps the Mac's LAN address in exactly ONE file, bracemark-expo's
// gitignored `.env.development.local`, rather than needing a matching edit here.
//
// Trusting a caller-supplied Host would be host-header injection anywhere else;
// here it is confined behind the isLocalR2 gate — the same gate that makes the
// proxy an unauthenticated read/write of the whole bucket — so it never exists in
// staging or production, where presigning names R2's endpoint and ignores this.
export function localBlobUrl(key: string, requestUrl: string): string {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${new URL(requestUrl).origin}${LOCAL_BLOB_PATH_PREFIX}${encoded}`;
}
