import { DEFAULT_RETRY_MAX_DELAY_MS } from '../api/retry';
import {
  BlobNetworkError,
  BlobRequestError,
  BlobTimeoutError,
  isTransientBlobError,
  isTransientBlobStatus,
  retryTransientBlobTransfer,
} from './blob-transfer';

// A stand-in for either platform's BlobRequestError: the helper never sees the
// class, only the caller's verdict on it.
class StatusError extends Error {
  constructor(readonly status: number) {
    super(`status ${status}`);
  }
}

const isTransient = (err: unknown) =>
  err instanceof StatusError && isTransientBlobStatus(err.status);

// A transfer that throws one scripted error per attempt, then resolves 'done'.
function scripted(...errors: Error[]): { transfer: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    transfer: async () => {
      const err = errors[calls++];
      if (err) throw err;
      return 'done';
    },
    calls: () => calls,
  };
}

describe('isTransientBlobStatus', () => {
  it('is a 5xx or a 429 — what a host answers when a later try may land', () => {
    expect([500, 502, 503, 429].map(isTransientBlobStatus)).toEqual([true, true, true, true]);
  });

  it('is never another 4xx: those answer the request on its merits', () => {
    expect([400, 403, 404, 413].map(isTransientBlobStatus)).toEqual([false, false, false, false]);
  });
});

describe('retryTransientBlobTransfer', () => {
  it('tries again after a transient failure, and resolves with the attempt that landed', async () => {
    const sleeps: number[] = [];
    const { transfer, calls } = scripted(new StatusError(500));

    await expect(
      retryTransientBlobTransfer(transfer, isTransient, {
        sleep: async (ms) => void sleeps.push(ms),
      }),
    ).resolves.toBe('done');
    expect(calls()).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it('stops at `tries`, and the last attempt’s error is what propagates', async () => {
    const last = new StatusError(503);
    const { transfer, calls } = scripted(new StatusError(500), new StatusError(502), last);

    await expect(
      retryTransientBlobTransfer(transfer, isTransient, { tries: 3, sleep: async () => undefined }),
    ).rejects.toBe(last);
    expect(calls()).toBe(3);
  });

  it('never retries what the caller calls permanent', async () => {
    const expired = new StatusError(403);
    const { transfer, calls } = scripted(expired);
    const sleep = jest.fn(async () => undefined);

    await expect(retryTransientBlobTransfer(transfer, isTransient, { sleep })).rejects.toBe(
      expired,
    );
    expect(calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('backs off from the base, doubling, never earlier than the doubled base', async () => {
    const sleeps: number[] = [];
    const { transfer } = scripted(new StatusError(500), new StatusError(500));

    await retryTransientBlobTransfer(transfer, isTransient, {
      tries: 3,
      baseDelayMs: 1_000,
      sleep: async (ms) => void sleeps.push(ms),
    });

    // Upward jitter of up to 25% (api/retry.ts jitteredDelayMs).
    expect(sleeps[0]).toBeGreaterThanOrEqual(1_000);
    expect(sleeps[0]).toBeLessThan(1_250);
    expect(sleeps[1]).toBeGreaterThanOrEqual(2_000);
    expect(sleeps[1]).toBeLessThan(2_500);
  });
});

describe('isTransientBlobError', () => {
  it('is a refusal for now, or a connection that dropped', () => {
    expect(isTransientBlobError(new BlobRequestError('PUT', 503))).toBe(true);
    expect(isTransientBlobError(new BlobNetworkError('PUT', new Error('lost')))).toBe(true);
  });

  // Each of these is the second pass's (sync/retry.ts), not this one's.
  it('is never an expired token or a spent deadline', () => {
    expect(isTransientBlobError(new BlobRequestError('PUT', 403))).toBe(false);
    expect(isTransientBlobError(new BlobTimeoutError('PUT', 60_000))).toBe(false);
  });
});

// The blob route's `blob` limiter answers a 429 with the window's length; a retry
// inside it only spends the bucket again.
describe('a 429 with a Retry-After', () => {
  it('waits out the hint instead of the backoff', async () => {
    const sleeps: number[] = [];
    const { transfer } = scripted(new BlobRequestError('PUT', 429, 7));

    await retryTransientBlobTransfer(transfer, isTransientBlobError, {
      baseDelayMs: 1_000,
      sleep: async (ms) => void sleeps.push(ms),
    });

    expect(sleeps[0]).toBeGreaterThanOrEqual(7_000);
    expect(sleeps[0]).toBeLessThan(7_000 * 1.25);
  });

  it('never waits past the api retry’s ceiling, whatever the hint says', async () => {
    const sleeps: number[] = [];
    const { transfer } = scripted(new BlobRequestError('PUT', 429, 3_600));

    await retryTransientBlobTransfer(transfer, isTransientBlobError, {
      sleep: async (ms) => void sleeps.push(ms),
    });

    expect(sleeps).toEqual([DEFAULT_RETRY_MAX_DELAY_MS]);
  });
});
