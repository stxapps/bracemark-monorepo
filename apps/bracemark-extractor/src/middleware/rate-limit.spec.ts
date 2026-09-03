import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { app } from '../app';
import type { RateLimit } from '../lib/env';

// The limiter is load-bearing for an anonymous open-fetch service, and its KEY is
// a published fact: /privacy and /extractor both tell readers the cap is keyed on
// the caller's IP, because a cap on an anonymous service has to be keyed on
// something and saying "we store nothing" while keying on an IP is falsifiable.
// So the key shape is a contract, not an internal.

// A limiter that records the keys it was asked about. Structurally a RateLimit, so
// it drops straight into the bindings `app.request()` hands the handlers.
function recordingLimiter(success = true): RateLimit & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    limit: ({ key }) => {
      keys.push(key);
      return Promise.resolve({ success });
    },
  };
}

describe('rate limiting', () => {
  it('counts per caller IP, from cf-connecting-ip', async () => {
    const limiter = recordingLimiter();

    await app.request(
      '/health',
      { headers: { 'cf-connecting-ip': '203.0.113.9' } },
      { ...env, API_RATE_LIMIT: limiter },
    );
    expect(limiter.keys).toEqual(['203.0.113.9:/health']);
  });

  it('gives each caller its own bucket', async () => {
    const limiter = recordingLimiter();
    const bindings = { ...env, API_RATE_LIMIT: limiter };

    await app.request('/health', { headers: { 'cf-connecting-ip': '203.0.113.9' } }, bindings);
    await app.request('/health', { headers: { 'cf-connecting-ip': '198.51.100.4' } }, bindings);
    expect(new Set(limiter.keys).size).toBe(2);
  });

  it('gives each endpoint its own bucket, so a flood of one spares the others', async () => {
    const limiter = recordingLimiter();
    const bindings = { ...env, API_RATE_LIMIT: limiter };
    const headers = { 'cf-connecting-ip': '203.0.113.9' };

    await app.request('/health', { headers }, bindings);
    await app.request('/', { headers }, bindings);
    expect(limiter.keys).toEqual(['203.0.113.9:/health', '203.0.113.9:/']);
  });

  it('falls back to a placeholder key when the edge sent no IP', async () => {
    // Never keyed on `undefined` (which would collapse every caller into one
    // bucket silently) — an IP-less request shares one explicit bucket.
    const limiter = recordingLimiter();

    await app.request('/health', {}, { ...env, API_RATE_LIMIT: limiter });
    expect(limiter.keys).toEqual(['unknown:/health']);
  });

  it('fails OPEN when the binding is absent', async () => {
    // No env at all — the unconfigured/off-Workers case. An unbound limiter must
    // not take the service down.
    const res = await app.request('/health');

    expect(res.status).toBe(200);
  });

  it('429s the request the limiter rejects, and lets the next caller through', async () => {
    const denying = recordingLimiter(false);
    const allowing = recordingLimiter(true);

    const blocked = await app.request('/health', {}, { ...env, API_RATE_LIMIT: denying });
    expect(blocked.status).toBe(429);

    const allowed = await app.request('/health', {}, { ...env, API_RATE_LIMIT: allowing });
    expect(allowed.status).toBe(200);
  });
});
