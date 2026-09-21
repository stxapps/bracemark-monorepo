import { z } from '../zod';
import type { ApiClient, CallOptions } from './client';
import { ApiError } from './client';
import type { ApiEndpoint } from './endpoint';
import { defineEndpoint } from './endpoint';
import { isRetryableTransportError, jitteredDelayMs, retryAfterMsOf, withRetry } from './retry';

// The endpoint arg is opaque to withRetry (it forwards to the wrapped client), so
// any well-formed descriptor does.
const endpoint = defineEndpoint({
  method: 'GET',
  path: '/v1/test',
  request: z.object({ cursor: z.string().optional() }),
  response: z.unknown(),
});

type Recorded = [ApiEndpoint, unknown, CallOptions | undefined];

// A client whose call() pops one scripted outcome per attempt; a `new Error`-free
// entry resolves with it. Records every attempt's arguments.
function scriptedApi(outcomes: (unknown | Error)[]): {
  api: ApiClient;
  calls: () => number;
  recorded: Recorded[];
} {
  const recorded: Recorded[] = [];
  const api: ApiClient = {
    call: (async (ep: ApiEndpoint, input: unknown, callOptions?: CallOptions) => {
      recorded.push([ep, input, callOptions]);
      const outcome = outcomes[recorded.length - 1];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }) as ApiClient['call'],
  };
  return { api, calls: () => recorded.length, recorded };
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

  it('forwards the endpoint, input and call options to the wrapped client unchanged', async () => {
    // The wrapper is transparent by contract — callers keep passing what they
    // always did, including the signal the abort rule below depends on.
    const { api, recorded } = scriptedApi([new ApiError(429, ''), { ok: true }]);
    const { sleep } = fakeSleep();
    const input = { cursor: 'page-9' };
    const callOptions = { signal: new AbortController().signal };

    await withRetry(api, { sleep }).call(endpoint, input, callOptions);

    expect(recorded).toHaveLength(2);
    for (const [ep, sent, opts] of recorded) {
      expect(ep).toBe(endpoint);
      expect(sent).toBe(input);
      expect(opts).toBe(callOptions);
    }
  });

  it('waits the Retry-After hint (jittered upward) instead of the backoff', async () => {
    const { api } = scriptedApi([new ApiError(429, '', 30), { ok: true }]);
    const { sleep, slept } = fakeSleep();

    await withRetry(api, { sleep }).call(endpoint, {});

    expect(slept[0]).toBeGreaterThanOrEqual(30_000);
    expect(slept[0]).toBeLessThanOrEqual(37_500); // 30s * 1.25 jitter ceiling
  });

  it('honors a zero-second hint as an immediate retry, not as a missing hint', async () => {
    // `Retry-After: 0` and no header at all take different branches: a
    // `hintMs || backoffMs` shortcut would silently turn "go now" into a 5s wait.
    const { api } = scriptedApi([new ApiError(429, '', 0), { ok: true }]);
    const { sleep, slept } = fakeSleep();

    await withRetry(api, { sleep, baseDelayMs: 5_000 }).call(endpoint, {});

    expect(slept).toEqual([0]);
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

  it('caps the exponential ladder at maxDelayMs', async () => {
    const { api } = scriptedApi([
      new ApiError(500, ''),
      new ApiError(500, ''),
      new ApiError(500, ''),
      { ok: true },
    ]);
    const { sleep, slept } = fakeSleep();

    await withRetry(api, { sleep, baseDelayMs: 1_000, maxDelayMs: 2_000 }).call(endpoint, {});

    // 1s with jitter, then 2s: once the base reaches the ceiling there is no room
    // for upward jitter without making maxDelayMs cease to be a maximum.
    expect(slept[0]).toBeLessThanOrEqual(1_250);
    expect(slept[1]).toBe(2_000);
    expect(slept[2]).toBe(2_000);
  });

  it('caps a long Retry-After hint at maxDelayMs rather than blocking for it', async () => {
    // withRetry blocks the calling frame (the sync engine's cycle), so a server
    // that answers "come back in five minutes" must not hold it for five minutes.
    const { api } = scriptedApi([new ApiError(429, '', 300), { ok: true }]);
    const { sleep, slept } = fakeSleep();

    await withRetry(api, { sleep, maxDelayMs: 60_000 }).call(endpoint, {});

    expect(slept[0]).toBe(60_000);
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

  it('does not retry a non-transport throw — a bug surfaces instead of spinning', async () => {
    const bug = new Error('bug');
    const { api, calls } = scriptedApi([bug, { ok: true }]);
    const { sleep, slept } = fakeSleep();

    await expect(withRetry(api, { sleep }).call(endpoint, {})).rejects.toBe(bug);
    expect(calls()).toBe(1);
    expect(slept).toHaveLength(0);
  });

  it('does not revive a call whose signal was aborted', async () => {
    // A caller-side abort can surface as a retryable-looking failure (a 5xx
    // already in flight, a fetch TypeError). Retrying it would resurrect a
    // request the caller has already superseded — a stale debounced username
    // answering after the current one.
    const controller = new AbortController();
    controller.abort();
    const { api, calls } = scriptedApi([new ApiError(503, ''), { ok: true }]);
    const { sleep, slept } = fakeSleep();

    await expect(
      withRetry(api, { sleep }).call(endpoint, {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ status: 503 });
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

  it('makes 4 attempts by default', async () => {
    const { api, calls } = scriptedApi(Array.from({ length: 5 }, () => new ApiError(429, '')));
    const { sleep, slept } = fakeSleep();

    await expect(withRetry(api, { sleep }).call(endpoint, {})).rejects.toMatchObject({
      status: 429,
    });
    expect(calls()).toBe(4);
    expect(slept).toHaveLength(3);
  });

  it('makes a single attempt at `tries: 1` — no retry, no wait', async () => {
    const { api, calls } = scriptedApi([new ApiError(429, ''), { ok: true }]);
    const { sleep, slept } = fakeSleep();

    await expect(withRetry(api, { sleep, tries: 1 }).call(endpoint, {})).rejects.toMatchObject({
      status: 429,
    });
    expect(calls()).toBe(1);
    expect(slept).toHaveLength(0);
  });
});

describe('isRetryableTransportError', () => {
  it('classifies 429/5xx/network as retryable, other errors as not', () => {
    expect(isRetryableTransportError(new ApiError(429, ''))).toBe(true);
    expect(isRetryableTransportError(new ApiError(500, ''))).toBe(true); // the 5xx floor
    expect(isRetryableTransportError(new ApiError(503, ''))).toBe(true);
    expect(isRetryableTransportError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryableTransportError(new ApiError(400, ''))).toBe(false);
    expect(isRetryableTransportError(new ApiError(403, ''))).toBe(false);
    expect(isRetryableTransportError(new ApiError(499, ''))).toBe(false); // just under the floor
    expect(isRetryableTransportError(new Error('bug'))).toBe(false);
  });

  it('does not retry an abort', () => {
    // fetch rejects an aborted request with a DOMException, not a TypeError —
    // the distinction is the only thing keeping a cancelled call from respawning.
    expect(isRetryableTransportError(new DOMException('Aborted', 'AbortError'))).toBe(false);
  });

  it('does not retry a non-error throw', () => {
    expect(isRetryableTransportError('429')).toBe(false);
    expect(isRetryableTransportError(undefined)).toBe(false);
  });
});

describe('retryAfterMsOf', () => {
  it('returns the hint in ms, or undefined when absent', () => {
    expect(retryAfterMsOf(new ApiError(429, '', 60))).toBe(60_000);
    expect(retryAfterMsOf(new ApiError(429, ''))).toBeUndefined();
    expect(retryAfterMsOf(new TypeError('Failed to fetch'))).toBeUndefined();
  });

  it('distinguishes a zero hint from no hint', () => {
    expect(retryAfterMsOf(new ApiError(429, '', 0))).toBe(0);
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

  it('leaves a zero base at zero', () => {
    expect(jitteredDelayMs(0)).toBe(0);
  });
});
