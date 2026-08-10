import { z } from 'zod';

import type { ApiClient } from './client';
import { ApiError, parseRetryAfterSeconds } from './client';
import { defineEndpoint } from './endpoint';
import { isRetryableTransportError, jitteredDelayMs, retryAfterMsOf, withRetry } from './retry';

// The endpoint arg is opaque to withRetry (it forwards to the wrapped client), so
// any well-formed descriptor does.
const endpoint = defineEndpoint({
  method: 'GET',
  path: '/v1/test',
  request: z.object({}),
  response: z.unknown(),
});

// A client whose call() pops one scripted outcome per attempt; a `new Error`-free
// entry resolves with it. Records how many attempts were made.
function scriptedApi(outcomes: (unknown | Error)[]): { api: ApiClient; calls: () => number } {
  let n = 0;
  const api: ApiClient = {
    call: (async () => {
      const outcome = outcomes[n++];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }) as ApiClient['call'],
  };
  return { api, calls: () => n };
}

// Capture sleeps instead of waiting them out.
function fakeSleep(): { sleep: (ms: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return { sleep: (ms) => (slept.push(ms), Promise.resolve()), slept };
}

describe('withRetry', () => {
  it('retries a 429 and returns the eventual success', async () => {
    const { api, calls } = scriptedApi([new ApiError(429, ''), { ok: true }]);
    const { sleep, slept } = fakeSleep();

    const res = await withRetry(api, { sleep }).call(endpoint, {});

    expect(res).toEqual({ ok: true });
    expect(calls()).toBe(2);
    expect(slept).toHaveLength(1);
  });

  it('waits the Retry-After hint (jittered upward) instead of the backoff', async () => {
    const { api } = scriptedApi([new ApiError(429, '', 30), { ok: true }]);
    const { sleep, slept } = fakeSleep();

    await withRetry(api, { sleep }).call(endpoint, {});

    expect(slept[0]).toBeGreaterThanOrEqual(30_000);
    expect(slept[0]).toBeLessThanOrEqual(37_500); // 30s * 1.25 jitter ceiling
  });

  it('backs off exponentially when the error carries no hint', async () => {
    const { api } = scriptedApi([
      new TypeError('Failed to fetch'),
      new ApiError(500, ''),
      { ok: true },
    ]);
    const { sleep, slept } = fakeSleep();

    await withRetry(api, { sleep, baseDelayMs: 1_000 }).call(endpoint, {});

    expect(slept[0]).toBeGreaterThanOrEqual(1_000);
    expect(slept[0]).toBeLessThanOrEqual(1_250);
    expect(slept[1]).toBeGreaterThanOrEqual(2_000);
    expect(slept[1]).toBeLessThanOrEqual(2_500);
  });

  it('does not retry a non-429 4xx', async () => {
    const { api, calls } = scriptedApi([new ApiError(400, 'bad'), { ok: true }]);
    const { sleep, slept } = fakeSleep();

    await expect(withRetry(api, { sleep }).call(endpoint, {})).rejects.toMatchObject({
      status: 400,
    });
    expect(calls()).toBe(1);
    expect(slept).toHaveLength(0);
  });

  it('gives up after `tries` attempts and rethrows the last failure', async () => {
    const outcomes = [new ApiError(429, ''), new ApiError(429, ''), new ApiError(429, '')];
    const { api, calls } = scriptedApi(outcomes);
    const { sleep } = fakeSleep();

    await expect(withRetry(api, { sleep, tries: 3 }).call(endpoint, {})).rejects.toMatchObject({
      status: 429,
    });
    expect(calls()).toBe(3);
  });
});

describe('isRetryableTransportError', () => {
  it('classifies 429/5xx/network as retryable, other errors as not', () => {
    expect(isRetryableTransportError(new ApiError(429, ''))).toBe(true);
    expect(isRetryableTransportError(new ApiError(503, ''))).toBe(true);
    expect(isRetryableTransportError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryableTransportError(new ApiError(400, ''))).toBe(false);
    expect(isRetryableTransportError(new Error('bug'))).toBe(false);
  });
});

describe('retryAfterMsOf', () => {
  it('returns the hint in ms, or undefined when absent', () => {
    expect(retryAfterMsOf(new ApiError(429, '', 60))).toBe(60_000);
    expect(retryAfterMsOf(new ApiError(429, ''))).toBeUndefined();
    expect(retryAfterMsOf(new TypeError('Failed to fetch'))).toBeUndefined();
  });
});

describe('jitteredDelayMs', () => {
  it('never fires earlier than the base', () => {
    for (let i = 0; i < 20; i++) {
      const d = jitteredDelayMs(10_000);
      expect(d).toBeGreaterThanOrEqual(10_000);
      expect(d).toBeLessThanOrEqual(12_500);
    }
  });
});

describe('parseRetryAfterSeconds', () => {
  // Duck-typed responses keep the test free of the global Response/Headers.
  function resWithHeader(value: string | null): Response {
    return { headers: { get: () => value } } as unknown as Response;
  }

  it('parses the delta-seconds form', () => {
    expect(parseRetryAfterSeconds(resWithHeader('60'))).toBe(60);
  });

  it('parses the HTTP-date form as a delta from now', () => {
    const date = new Date(Date.now() + 30_000).toUTCString();
    const parsed = parseRetryAfterSeconds(resWithHeader(date));
    expect(parsed).toBeGreaterThan(25);
    expect(parsed).toBeLessThanOrEqual(30);
  });

  it('returns undefined when absent or garbage', () => {
    expect(parseRetryAfterSeconds(resWithHeader(null))).toBeUndefined();
    expect(parseRetryAfterSeconds(resWithHeader('soon'))).toBeUndefined();
  });
});
