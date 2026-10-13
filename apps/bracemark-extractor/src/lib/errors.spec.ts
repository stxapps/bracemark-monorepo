import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { AppEnv } from './env';
import { errorHandler } from './errors';

// bracemark-api's errors.spec.ts pins the envelope both Workers share. What is
// pinned here is the one branch this Worker handles DIFFERENTLY, and why: an
// unexpected throw is logged by name only. This log is stored, and the request
// line is kept out of it by `invocation_logs: false` — but a console line is not
// the request line, so an error message that quotes the URL would put it back.
describe('errorHandler', () => {
  const SAVED = 'https://example.com/a-page-someone-saved?token=abc';

  const app = new Hono<AppEnv>().onError(errorHandler).get('/bug', () => {
    // The shape a runtime error really takes: the offending input, quoted.
    throw new TypeError(`Invalid URL: ${SAVED}`);
  });

  it('logs an unexpected throw by its name, never the error that may quote the URL', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await app.request('/bug');

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'internal_error' });
    // Positive control: the failure IS observable, and says what kind it was.
    expect(logged).toHaveBeenCalledWith('Unhandled error:', 'TypeError');
    // …and nothing handed to the log carries the address — not as a string, not
    // inside an Error whose message does.
    const printed = logged.mock.calls.flat().map((arg) => String(arg));
    expect(printed.join(' ')).not.toContain('example.com');

    logged.mockRestore();
  });
});
