import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { app } from '../app';
import { formatTimings } from './server-timing';

// The Server-Timing breakdown `measure:sync` reads (docs/local-first-sync.md,
// _measuring a sync_). Two things worth pinning: production's responses carry
// none of it, and the metric a sync reading leans on — the session read every
// sync call waits behind — is actually in the header when it is on.
describe('Server-Timing', () => {
  const unknownToken = { headers: { Authorization: 'Bearer not-a-session' } };

  it('is absent when SERVER_TIMING is unset, as in production', async () => {
    const res = await app.request('/v1/ops/list?since=0&limit=1', unknownToken, {
      ...env,
      SERVER_TIMING: undefined,
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('server-timing')).toBeNull();
    expect(res.headers.get('timing-allow-origin')).toBeNull();
  });

  it('times the session read and the whole request when on, a refused one too', async () => {
    const res = await app.request('/v1/ops/list?since=0&limit=1', unknownToken, {
      ...env,
      SERVER_TIMING: '1',
    });

    expect(res.status).toBe(401);
    expect(res.headers.get('server-timing')).toMatch(/^auth;dur=\d+, total;dur=\d+$/);
  });

  it('opens the header to page timing for an allowed origin only', async () => {
    const on = { ...env, SERVER_TIMING: '1', CORS_ORIGINS: 'https://app.example' };
    const allowed = await app.request(
      '/health',
      { headers: { Origin: 'https://app.example' } },
      on,
    );
    const other = await app.request('/health', { headers: { Origin: 'https://evil.example' } }, on);

    expect(allowed.headers.get('timing-allow-origin')).toBe('https://app.example');
    expect(other.headers.get('timing-allow-origin')).toBeNull();
  });

  it('writes a repeated metric as its sum with a count', () => {
    const header = formatTimings(
      new Map([
        ['r2-stat', { ms: 40, n: 1 }],
        ['r2-head', { ms: 900, n: 500 }],
      ]),
    );
    expect(header).toBe('r2-stat;dur=40, r2-head;dur=900;desc="n=500"');
  });
});
