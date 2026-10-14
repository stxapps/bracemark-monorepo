import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { ErrorBody } from '@stxapps/shared';

import type { AppEnv } from './env';

// Uniform JSON error handling. Middleware and handlers `throw new HttpError(...)`
// instead of building ad-hoc `c.json(..., 4xx)` responses; `errorHandler` (wired
// via `app.onError` in app.ts) turns every thrown error into the same shape:
//
//   { "error": "<code>", "message"?: "<human readable>" }
//
// `code` is a stable, client-parseable string (e.g. 'unauthorized',
// 'rate_limited'); `message` is optional and for humans/logs only.

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

  // Anything else is an unexpected bug. Log it for observability (wrangler tail
  // / the observability binding) but never leak internals to the client.
  //
  // `name: message` goes in as its own string, ahead of the object. Handed only
  // the object, the stored log kept the stack frames and dropped the line that
  // says what went wrong: the commit 500s on staging (a full batch over the
  // per-invocation subrequest limit) read back as nothing but `at Object.head …`.
  const summary = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error('Unhandled error:', summary, err);
  return c.json({ error: 'internal_error' }, 500);
}
