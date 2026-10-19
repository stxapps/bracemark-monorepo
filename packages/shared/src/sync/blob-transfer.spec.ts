import { isTransientBlobStatus, retryTransientBlobTransfer } from './blob-transfer';

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
