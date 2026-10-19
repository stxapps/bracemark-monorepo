import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv, Bindings, RateLimit } from '../lib/env';
import { errorHandler } from '../lib/errors';
import { blobRateLimitKey, ipRateLimitKey, rateLimit, userRateLimitKey } from './rate-limit';

// The limiter's two silent-failure surfaces. app.spec.ts pins the standard
// tier's 429 envelope through the real app; what a route test can't show is
// WHICH binding a tier consumed and WHAT key it counted under — a tier wired to
// the wrong binding, or a per-user key that quietly falls back to IP, changes
// nothing observable in a response. Both are asserted here against recording
// fakes, one per binding.

type Recorder = RateLimit & { keys: string[] };

function limiter(success: boolean): Recorder {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success };
    },
  };
}

// Every tier's binding present and allowing, so a test only has to say which one
// it expects to have been consulted.
function bindings(overrides: Partial<Record<keyof Bindings, unknown>> = {}) {
  return {
    API_RATE_LIMIT: limiter(true),
    API_RATE_LIMIT_TIGHT: limiter(true),
    API_RATE_LIMIT_WEBHOOK: limiter(true),
    ...overrides,
  } as unknown as Bindings & {
    API_RATE_LIMIT: Recorder;
    API_RATE_LIMIT_TIGHT: Recorder;
    API_RATE_LIMIT_WEBHOOK: Recorder;
  };
}

const ok = (c: { text: (t: string) => Response }) => c.text('ok');

describe('rateLimit', () => {
  it('counts each tier against its OWN binding, and no other', async () => {
    const app = new Hono<AppEnv>()
      .onError(errorHandler)
      .get('/standard', rateLimit('standard'), ok)
      .get('/tight', rateLimit('tight'), ok)
      .get('/webhook', rateLimit('webhook'), ok);
    const env = bindings();

    await app.request('/standard', {}, env);
    await app.request('/tight', {}, env);
    await app.request('/webhook', {}, env);

    expect(env.API_RATE_LIMIT.keys).toEqual(['unknown:/standard']);
    expect(env.API_RATE_LIMIT_TIGHT.keys).toEqual(['unknown:/tight']);
    expect(env.API_RATE_LIMIT_WEBHOOK.keys).toEqual(['unknown:/webhook']);
  });

  // Retry-After is the only reset signal a client gets (the binding exposes no
  // window), so a tier answering with another tier's period tells clients to
  // wait 6x too long — or, worse, 6x too short into a still-saturated window.
  it('sends the tier’s own window as Retry-After on a 429', async () => {
    const app = new Hono<AppEnv>()
      .onError(errorHandler)
      .get('/tight', rateLimit('tight'), ok)
      .get('/webhook', rateLimit('webhook'), ok);
    const env = bindings({
      API_RATE_LIMIT_TIGHT: limiter(false),
      API_RATE_LIMIT_WEBHOOK: limiter(false),
    });

    const tight = await app.request('/tight', {}, env);
    expect(tight.status).toBe(429);
    // Literals, not RATE_LIMIT_PERIODS: the number IS the contract with
    // wrangler.jsonc's `simple.period` for that binding (10s for both of these,
    // 60s for standard — app.spec.ts pins that one), and asserting the constant
    // against itself would follow a mistyped period straight into the header.
    expect(tight.headers.get('retry-after')).toBe('10');

    const webhook = await app.request('/webhook', {}, env);
    expect(webhook.headers.get('retry-after')).toBe('10');
  });

  it('runs the handler when a limiter binding is absent — an unconfigured limiter must not take the API down', async () => {
    const app = new Hono<AppEnv>().onError(errorHandler).get('/x', rateLimit('tight'), ok);

    // No env at all (the app.request() shape), then an env missing just this tier.
    expect((await app.request('/x')).status).toBe(200);
    expect(
      (await app.request('/x', {}, { API_RATE_LIMIT: limiter(false) } as unknown as Bindings))
        .status,
    ).toBe(200);
  });

  it('gives each (caller, endpoint) pair its own bucket', async () => {
    const app = new Hono<AppEnv>()
      .onError(errorHandler)
      .get('/a', rateLimit('standard'), ok)
      .get('/b', rateLimit('standard'), ok);
    const env = bindings();
    const from = (ip: string) => ({ headers: { 'cf-connecting-ip': ip } });

    await app.request('/a', from('203.0.113.7'), env);
    await app.request('/b', from('203.0.113.7'), env);
    await app.request('/a', from('198.51.100.2'), env);

    // Three distinct buckets: flooding one endpoint must not throttle the
    // others, and one caller must not throttle another.
    expect(env.API_RATE_LIMIT.keys).toEqual([
      '203.0.113.7:/a',
      '203.0.113.7:/b',
      '198.51.100.2:/a',
    ]);
  });

  it('keys an authed endpoint by user, so one account cannot multiply its quota across IPs', async () => {
    const app = new Hono<AppEnv>()
      .onError(errorHandler)
      .use('/authed', async (c, next) => {
        c.set('session', { id: 's1', userId: 'u_42', accountDbId: '1' });
        await next();
      })
      .get('/authed', rateLimit('tight', userRateLimitKey), ok)
      // Same key fn with no session resolved — the fallback arm.
      .get('/anon', rateLimit('tight', userRateLimitKey), ok);
    const env = bindings();

    await app.request('/authed', { headers: { 'cf-connecting-ip': '203.0.113.7' } }, env);
    await app.request('/authed', { headers: { 'cf-connecting-ip': '198.51.100.2' } }, env);
    await app.request('/anon', { headers: { 'cf-connecting-ip': '203.0.113.7' } }, env);

    expect(env.API_RATE_LIMIT_TIGHT.keys).toEqual([
      'user:u_42:/authed',
      'user:u_42:/authed', // same bucket from a second IP
      '203.0.113.7:/anon', // no session yet → IP+path
    ]);
  });
});

// The blob tier's refusal log is the only place an abusing account is named
// (rate-limit.ts noteBlobRefusal) — nothing in a response shows whether it was
// written, so a regression is silent until the day it is needed.
describe('a refused blob transfer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function blobApp(userId: string) {
    return new Hono<AppEnv>()
      .onError(errorHandler)
      .use('/blob', async (c, next) => {
        c.set('blobGrant', { userId, path: 'links/a.enc' });
        await next();
      })
      .put('/blob', rateLimit('blob', blobRateLimitKey), ok);
  }

  it('names the account, and never the path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = bindings({ API_RATE_LIMIT_BLOB: limiter(false) });

    const res = await blobApp('u_refused').request('/blob', { method: 'PUT' }, env);

    expect(res.status).toBe(429);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain('u_refused');
    expect(line).not.toContain('links/a.enc');
  });

  it('logs once per account per window, so a flood adds one line, not one per request', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const env = bindings({ API_RATE_LIMIT_BLOB: limiter(false) });
    const app = blobApp('u_flood');

    for (let i = 0; i < 5; i++) await app.request('/blob', { method: 'PUT' }, env);
    expect(warn).toHaveBeenCalledTimes(1);

    // Literal 10 s: the blob binding's `simple.period` in wrangler.jsonc.
    vi.advanceTimersByTime(10_000);
    await app.request('/blob', { method: 'PUT' }, env);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('logs nothing for an allowed transfer, or a refusal on another tier', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await blobApp('u_allowed').request(
      '/blob',
      { method: 'PUT' },
      bindings({ API_RATE_LIMIT_BLOB: limiter(true) }),
    );
    const tight = new Hono<AppEnv>().onError(errorHandler).get('/t', rateLimit('tight'), ok);
    await tight.request('/t', {}, bindings({ API_RATE_LIMIT_TIGHT: limiter(false) }));

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the key strategies', () => {
  // Called directly so the fallback is visible without a request: a caller with
  // no cf-connecting-ip (only possible off Cloudflare's edge) must still land in
  // a bucket rather than crash or share the empty string with a path.
  it('falls back to a literal `unknown` IP, still per-path', async () => {
    const app = new Hono<AppEnv>().get('/p', (c) => c.text(ipRateLimitKey(c)));

    await expect((await app.request('/p')).text()).resolves.toBe('unknown:/p');
  });
});
