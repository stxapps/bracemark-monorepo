import { type Context, Hono } from 'hono';
import { createMiddleware } from 'hono/factory';

import { BLOB_PATH, type BlobPutResponse } from '@stxapps/shared';

import type { AppEnv } from '../lib/env';
import { HttpError } from '../lib/errors';
import { timerFor } from '../lib/server-timing';
import { blobRateLimitKey, rateLimit } from '../middleware/rate-limit';
import {
  BLOB_AUTH_SCHEME,
  type BlobGrant,
  type BlobMethod,
  BlobTokenError,
  verifyBlobToken,
} from '../r2/blob-token';
import { mintUploadReceipt } from '../r2/upload-receipt';
import { userFilesRepo } from '../r2/user-files';

// PUT / GET / POST /v1/files/blob — the blob route: one object's ciphertext in or out,
// through the R2 binding, authorized by the token `files/sign` minted for it
// with `via: 'api'` (r2/blob-token.ts). It does what a presigned URL does, on a
// different connection. That connection is the point (docs/local-first-sync.md,
// _the blob route_):
//
//   - R2's S3 endpoint speaks HTTP/1.1 only, so a browser holds six sockets to it
//     and queues the rest. A sync fans out 24 transfers and ran six; the api's
//     host is HTTP/2 and HTTP/3, one connection carrying all 24.
//   - Every presigned PUT is preflighted, and a preflight is cached per URL, so
//     each upload cost a second round trip. Here every transfer has the same URL,
//     so the preflight is asked once per two hours (app.ts `maxAge`).
//
// THREE METHODS, TWO GRANTS. PUT writes, under a PUT token in `Authorization`.
// A read is either GET, under a GET token in `Authorization` — what a native
// client sends, and what expo's file download can only send — or POST, with that
// same `Authorization` value as its whole `text/plain` body, which is what a
// browser sends. Measured in Chrome against `wrangler dev`, 2026-10-19:
//
//   - A GET carrying `Authorization` is preflighted, and the preflight cache is
//     skipped for a read made with `cache: 'no-store'` — 673 preflights for 673
//     reads.
//   - Without `no-store`, the HTTP cache holds each read of the one URL behind
//     the one before it: the pull ran on two sockets of six, queued.
//
//   A POST whose body is `text/plain` and which sets no header of its own is a
//   CORS "simple" request, so it is never preflighted, and the HTTP cache never
//   stores a POST, so it never queues on one. The token in a body also stays out
//   of the invocation log, which stores headers and never bodies.
//   - Each request is its own Worker invocation making ONE R2 call, so the
//     Workers limit of six concurrent outgoing connections per invocation never
//     applies — it is what made the commit's HEADs slow, and why the fix for
//     those is a different one (r2/user-files.ts statMany).
//
// It streams and stores nothing of its own, like bracemark-extractor's image
// proxy: the bytes pass from the request to R2 (or back) and the Worker never
// holds a whole blob. Workers bill requests and CPU, not bandwidth, and a
// stream's wait is not CPU.
//
// NOT BEHIND requireAuth, deliberately: a session lookup is a D1 read per
// transfer (~280 ms from the edge, the `auth` metric), and the decision it would
// make was already made at `files/sign`. The token carries that decision
// (r2/blob-token.ts says what it does and does not outlive). A bad or expired
// token answers 403, as R2 answers a bad presign — never 401, which every client
// reads as a statement about its SESSION (docs/sessions.md).
//
// NOT BEHIND THE `standard` LIMITER (app.ts): that one buckets by IP + path, and
// this is one path for every object — a single push would empty a 60-per-minute
// bucket in seconds. It carries the `blob` tier instead, keyed by the user the
// token names, as an abuse bound on replaying a token (a GET token is good for an
// hour); a sync stays far under it.

// A token is one `Blob v1.…` value; anything near this size is not one.
const MAX_TOKEN_BODY_BYTES = 4096;

async function credentialOf(c: Context<AppEnv>, from: 'header' | 'body'): Promise<string> {
  if (from === 'header') return c.req.header('authorization') ?? '';
  const declared = Number(c.req.header('content-length') ?? 0);
  if (declared > MAX_TOKEN_BODY_BYTES) throw new HttpError(413, 'blob_token_invalid');
  const text = await c.req.text();
  return text.length > MAX_TOKEN_BODY_BYTES ? '' : text.trim();
}

// `method` is the grant the token must carry — a POST read is a GET grant.
function requireBlobToken(method: BlobMethod, from: 'header' | 'body' = 'header') {
  return createMiddleware<AppEnv>(async (c, next) => {
    const [scheme, token] = (await credentialOf(c, from)).split(' ');
    if (scheme !== BLOB_AUTH_SCHEME || !token) {
      throw new HttpError(403, 'blob_token_invalid', 'Missing blob token');
    }
    const secret = c.env?.R2_SECRET_ACCESS_KEY;
    if (!secret) {
      throw new HttpError(500, 'r2_unconfigured', 'R2 signing credentials are not configured');
    }
    try {
      c.set('blobGrant', await verifyBlobToken(secret, token, method));
    } catch (err) {
      if (err instanceof BlobTokenError) throw new HttpError(403, err.code);
      throw err;
    }
    return next();
  });
}

// Set by requireBlobToken, which runs first on both routes.
function grantOf(c: Context<AppEnv>): BlobGrant {
  const grant = c.get('blobGrant');
  if (!grant) throw new HttpError(403, 'blob_token_invalid');
  return grant;
}

async function read(c: Context<AppEnv>): Promise<Response> {
  const { userId, path } = grantOf(c);
  const object = await timerFor(c)('r2-get', () => userFilesRepo(c.env).get(userId, path));
  // Deleted since it was signed — another device's delete, not yet pulled. The
  // engines skip a 404 rather than fail the cycle, as they do R2's.
  if (!object) throw new HttpError(404, 'not_found', 'No such blob');
  // `no-store` is app.ts's, on every response; the header R2 answers with on a
  // presigned read had to be asked for in the URL (r2/presign.ts) because the
  // api never saw that response. This one it builds.
  return c.body(object.body, 200, {
    'content-type': 'application/octet-stream',
    'content-length': String(object.size),
    'x-content-type-options': 'nosniff',
  });
}

export const blobRoutes = new Hono<AppEnv>()
  .get(BLOB_PATH, requireBlobToken('GET'), rateLimit('blob', blobRateLimitKey), read)
  .post(BLOB_PATH, requireBlobToken('GET', 'body'), rateLimit('blob', blobRateLimitKey), read)
  .put(BLOB_PATH, requireBlobToken('PUT'), rateLimit('blob', blobRateLimitKey), async (c) => {
    const { userId, path, fence } = grantOf(c);
    const repo = userFilesRepo(c.env);
    // R2 takes a stream only when its length is known, which a request body is
    // when it declares one — every client's does (fetch and both native uploads
    // send Content-Length for a fixed body). Without one it is read whole first;
    // the request is bounded by Cloudflare's body limit either way.
    const body = c.req.raw.body;
    const stat = await timerFor(c)('r2-put', async () =>
      body && c.req.header('content-length')
        ? repo.put(userId, path, body)
        : repo.putBytes(userId, path, await c.req.arrayBuffer()),
    );
    // The commit, not this response, is where the object is recorded
    // (services/sync.ts commitOps), exactly as after a presigned PUT. What this
    // answers is the receipt the commit can take instead of asking R2 again
    // whether the object landed (r2/upload-receipt.ts): R2's answer to this PUT,
    // signed, under the fence the token carries. A token minted before receipts
    // carries no fence, and its PUT answers with none.
    const secret = c.env?.R2_SECRET_ACCESS_KEY;
    if (!stat || !fence || !secret) return c.json({} satisfies BlobPutResponse, 200);
    const receipt = await mintUploadReceipt(secret, { userId, path, stat, fence });
    return c.json({ receipt } satisfies BlobPutResponse, 200);
  });
