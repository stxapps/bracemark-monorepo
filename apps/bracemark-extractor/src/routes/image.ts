import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import { imageProxyEndpoint } from '@stxapps/shared';

import type { AppEnv } from '../lib/env';
import { HttpError } from '../lib/errors';
import { MAX_IMAGE_BYTES, safeFetch, SafeFetchError, streamWithLimit } from '../lib/safe-fetch';
import { rateLimit } from '../middleware/rate-limit';

// GET /v1/image?url=… — the stateless image proxy (docs "stream-don't-store"). The
// web app can't read cross-origin image bytes (CORS / tainted-canvas) and rendering
// the remote URL directly is the per-paint leak the design forbids — so this STREAMS
// the remote bytes THROUGH and buffers/persists nothing. The client encrypts the
// streamed bytes into `files/{id}.enc` itself.
//
// Same arbitrary-URL fetch as /extract, so it carries the SAME SSRF guard + timeout
// + redirect re-validation (all in safeFetch), plus an `image/*` content-type
// allowlist and the per-response byte ceiling (streamWithLimit). It NEVER resizes or
// transcodes — that would force a full decode (real CPU + OOM risk on the 128 MB
// isolate) and kill the streaming-is-free property; thumbnailing is a deferred
// CLIENT step before encrypt.

// Map an internal fetch failure to a clean HTTP status for this single-resource GET
// (unlike /extract, which records per-URL errors in a 200 body).
function statusForError(code: SafeFetchError['code']): number {
  switch (code) {
    case 'blocked':
      return 403;
    case 'unsupported_type':
      return 415;
    case 'too_large':
      return 413;
    case 'timeout':
      return 504;
    case 'bad_status':
    case 'fetch_failed':
      return 502;
    default:
      return 502;
  }
}

export const imageRoutes = new Hono<AppEnv>().get(
  imageProxyEndpoint.path,
  rateLimit('image'),
  zValidator('query', imageProxyEndpoint.request),
  async (c) => {
    const { url } = c.req.valid('query');

    let response: Response;
    try {
      ({ response } = await safeFetch(url, 'image/*'));
    } catch (err) {
      if (err instanceof SafeFetchError) {
        throw new HttpError(statusForError(err.code), err.code);
      }
      throw err;
    }

    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!contentType.toLowerCase().startsWith('image/')) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(415, 'unsupported_type');
    }

    // Early reject if the upstream declares an oversized body — cheaper than
    // streaming up to the cap before aborting. (streamWithLimit is still the real
    // ceiling, for when Content-Length is absent or lies.)
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new HttpError(413, 'too_large');
    }

    if (!response.body) {
      throw new HttpError(502, 'fetch_failed');
    }

    // Stream the bytes through, hard-aborting past the ceiling. Forward ONLY safe,
    // relevant headers — never upstream cookies/auth — and let the client cache the
    // (immutable) image. CORS headers are added by the global cors() middleware. There's
    // no server-side edge cache: the browser's own cache (via cache-control below) covers
    // per-user re-views, and an anonymous proxy buffering bytes for a rarely-read shared
    // cache would undercut the stream-don't-store property — the per-response byte ceiling
    // + timeout in safeFetch remain the real abuse floor.
    const limited = response.body.pipeThrough(streamWithLimit(MAX_IMAGE_BYTES));
    const headers = new Headers({
      'content-type': contentType,
      'cache-control': 'public, max-age=86400, immutable',
      'x-content-type-options': 'nosniff',
    });
    return new Response(limited, { status: 200, headers });
  },
);
