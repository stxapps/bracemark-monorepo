// `withDeadline` is exercised end to end through the contract client
// (api/client.spec.ts, _deadline_: a fetch that ignores its signal, an in-time
// answer, a server failure passing through, a caller's cancel). What only this
// file pins is `rearm`, which the client never uses: an R2 GET restarts its
// deadline on every body chunk (web-react sync/r2.ts). Its failure is silent
// either way — a rearm that leaves the old timer armed fails a large download
// that was still moving, and one that ADDS to the old clock instead of
// restarting it lets a stalled one hang long past its silence.
//
// Fake timers, so the deadline is reached by advancing the clock.

import { withDeadline } from './with-deadline';

describe('withDeadline — rearm', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const pending = async (outcome: Promise<unknown>) =>
    Promise.race([outcome, Promise.resolve('pending')]);

  it('restarts the clock from now with the new duration, replacing the old one', async () => {
    let rearmTo!: (ms: number) => void;
    const outcome = withDeadline(
      (_signal, rearm) => {
        rearmTo = rearm;
        return new Promise<never>(() => undefined);
      },
      1000,
      (ms) => new Error(`timed out after ${ms}`),
    ).catch((err: unknown) => err);

    await jest.advanceTimersByTimeAsync(900);
    rearmTo(5000);

    // The original deadline (t = 1000) passes without effect…
    await jest.advanceTimersByTimeAsync(4999);
    await expect(pending(outcome)).resolves.toBe('pending');
    expect(jest.getTimerCount()).toBe(1);

    // …and the re-armed one fires 5000 after the rearm, reporting its own length.
    await jest.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual(new Error('timed out after 5000'));
    expect(jest.getTimerCount()).toBe(0);
  });
});
