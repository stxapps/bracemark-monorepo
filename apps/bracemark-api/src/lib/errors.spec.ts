import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnv } from './env';
import { errorHandler, HttpError } from './errors';

// The uniform error envelope every client parses (`{ error, message? }`). Route
// specs assert individual codes; what's pinned here is the SHAPE contract at the
// three branches — our own HttpError, one of Hono's, and an unexpected throw —
// including the one that can leak: an internal stack must never reach a client,
// and a bug must never come back as a 2xx.
describe('errorHandler', () => {
  const app = new Hono<AppEnv>()
    .onError(errorHandler)
    .get('/http-error', () => {
      throw new HttpError(403, 'forbidden', 'Not your account', { 'x-hint': 'nope' });
    })
    .get('/code-only', () => {
      throw new HttpError(404, 'not_found');
    })
    .get('/hono-error', () => {
      throw new HTTPException(413, { message: 'Payload too large' });
    })
    .get('/bug', () => {
      throw new TypeError('cannot read properties of undefined (reading `secretToken`)');
    });

  it('renders an HttpError as its status, code, message and extra headers', async () => {
    const res = await app.request('/http-error');

    expect(res.status).toBe(403);
    expect(res.headers.get('x-hint')).toBe('nope');
    await expect(res.json()).resolves.toEqual({ error: 'forbidden', message: 'Not your account' });
  });

  // `message` defaults to the code inside HttpError, so a code-only throw would
  // otherwise echo the code twice — the field is for humans, and repeating the
  // machine-readable one tempts clients to read it.
  it('omits `message` when it would only restate the code', async () => {
    const res = await app.request('/code-only');

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
  });

  // Hono raises these itself (a body over the limit, a zValidator failure it
  // re-throws), so they must land in the same envelope rather than as Hono's
  // own plain-text response.
  it('gives one of Hono’s own exceptions the same envelope, keeping its status', async () => {
    const res = await app.request('/hono-error');

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: 'http_error',
      message: 'Payload too large',
    });
  });

  it('answers an unexpected throw with an opaque 500, logging it instead of leaking it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await app.request('/bug');

    expect(res.status).toBe(500);
    // No internals in the body — not the message, not a stack, not a field name.
    await expect(res.json()).resolves.toEqual({ error: 'internal_error' });
    // …but it IS observable in the log (wrangler tail / the observability binding),
    // its message as a string of its own — the stored log dropped it from the
    // object alone, leaving only the stack frames.
    expect(logged).toHaveBeenCalledWith(
      'Unhandled error:',
      'TypeError: cannot read properties of undefined (reading `secretToken`)',
      expect.any(TypeError),
    );
  });
});
