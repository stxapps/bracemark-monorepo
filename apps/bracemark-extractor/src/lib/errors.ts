import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { ErrorBody } from '@stxapps/shared';

import type { AppEnv } from './env';

// Uniform JSON error handling, identical in shape to bracemark-api so clients parse one
// error envelope across both origins. Middleware/handlers `throw new HttpError(...)`;
// `errorHandler` (wired via `app.onError` in app.ts) turns every thrown error into:
//
//   { "error": "<code>", "message"?: "<human readable>" }
//
// `code` is a stable, client-parseable string (e.g. 'rate_limited',
// 'invalid_request'); `message` is optional and for humans/logs only.
//
// IMPORTANT — never put the fetched URL in an error `message`. The extractor's whole
// reason to exist is that the URL it sees stays transient (docs "Never log the URL"),
// so error bodies and logs must stay aggregate/code-level, never echo the target URL.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
    /** Extra response headers, e.g. a 429's `Retry-After` (middleware/rate-limit.ts). */
    readonly headers?: Record<string, string>,
  ) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

export function errorHandler(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof HttpError) {
    const body: ErrorBody = { error: err.code };
    if (err.message && err.message !== err.code) body.message = err.message;
    return c.json(body, err.status as 400, err.headers);
  }

  // Hono's own thrown errors (incl. zValidator failures it re-raises) carry a
  // status + Response; surface their status with a generic code.
  if (err instanceof HTTPException) {
    return c.json({ error: 'http_error', message: err.message }, err.status);
  }

  // Anything else is an unexpected bug. Log THAT it happened and what kind it was
  // — the error's name only, exactly as `extractOne` does (routes/extract.ts) —
  // and never leak internals to the client.
  //
  // The name, not the error: this deliberately differs from bracemark-api's
  // handler, which prints the whole object. An unexpected error's message is not
  // ours to vouch for — a runtime TypeError can quote the string it choked on,
  // and in this Worker that string is the URL — and this log is stored, which is
  // the one thing `invocation_logs: false` in wrangler.jsonc does not cover.
  console.error('Unhandled error:', err instanceof Error ? err.name : 'unknown');
  return c.json({ error: 'internal_error' }, 500);
}
