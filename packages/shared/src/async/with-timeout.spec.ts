// Specs for the two things `withTimeout` promises beyond the obvious race: that it
// gets OUT OF THE WAY when the promise settles in time (the value and the error both
// pass through untouched — a wrapper that reported its own timeout in place of the
// real rejection would hide every genuine failure behind a false "too slow"), and
// that it ARMS AND DISARMS exactly one timer. The timer half is the silent one: a
// leaked two-minute timer never fails a run, it just holds the event loop open long
// after the work is done, and its only visible form is a slow suite or a jest
// open-handle warning that points nowhere near here.
//
// Fake timers, so the deadline is reached by advancing the clock rather than by
// waiting out a real one, and so the armed-timer count is readable at all.

import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('passes the value through and leaves no timer armed', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000, 'too slow')).resolves.toBe('done');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('passes the promise’s own rejection through, not the timeout message', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('offline')), 1000, 'too slow'),
    ).rejects.toThrow('offline');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects with the caller’s message once the deadline passes', async () => {
    const outcome = withTimeout(new Promise<void>(() => undefined), 1000, 'too slow').catch(
      (err: unknown) => err,
    );

    // Still waiting one tick short of the deadline — the positive control for the
    // assertion below, which a wrapper that rejected on the spot would also satisfy.
    await jest.advanceTimersByTimeAsync(999);
    await expect(Promise.race([outcome, Promise.resolve('pending')])).resolves.toBe('pending');
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual(new Error('too slow'));
    expect(jest.getTimerCount()).toBe(0);
  });
});
