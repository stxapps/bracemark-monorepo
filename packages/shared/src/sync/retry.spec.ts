import { ApiError, ApiTimeoutError } from '../api/client';
import { BlobUnreadableError } from '../crypto/blob-unreadable-error';
import { BlobNetworkError, BlobRequestError, BlobTimeoutError } from './blob-transfer';
import {
  createSyncRetryScheduler,
  INITIAL_SYNC_RETRY_DELAYS_MS,
  isSecondPassFailure,
  isTransientSyncFailure,
  jitteredSyncDelayMs,
  runInitialSyncWithRetries,
  SYNC_RETRY_DELAYS_MS,
  SYNC_RETRY_JITTER,
  SYNC_WAKE_MIN_INTERVAL_MS,
  SyncIncompleteError,
} from './retry';

// The failures a cycle can end in, by what a retry can do about them
// (docs/local-first-sync.md, _retrying a failure_, the table of cases).
const TRANSIENT: [string, unknown][] = [
  ['an api 429', new ApiError(429, '')],
  ['an api 5xx', new ApiError(500, '')],
  ['an api deadline', new ApiTimeoutError(60_000)],
  ['a dropped connection under an api call', new TypeError('Failed to fetch')],
  ['a blob 5xx', new BlobRequestError('PUT', 500)],
  ['a blob 429', new BlobRequestError('PUT', 429)],
  ['an expired blob token', new BlobRequestError('PUT', 403)],
  ['a blob deadline', new BlobTimeoutError('PUT', 60_000)],
  ['a dropped connection under a blob', new BlobNetworkError('PUT', new Error('lost'))],
  ['a path left unsigned', new SyncIncompleteError(1)],
];
const PERMANENT: [string, unknown][] = [
  ['a session the server refused', new ApiError(401, '{"error":"session_revoked"}')],
  ['a request refused on its merits', new ApiError(400, '')],
  ['a quota refusal', new ApiError(403, '{"error":"quota_exceeded"}')],
  ['a blob 400', new BlobRequestError('PUT', 400)],
  ['a blob that will not open', new BlobUnreadableError('links/l_a.enc')],
  ['a local store error', new Error('ConstraintError')],
];

describe('isTransientSyncFailure', () => {
  it.each(TRANSIENT)('schedules a retry after %s', (_, err) => {
    expect(isTransientSyncFailure(err)).toBe(true);
  });

  // Each of these fails the same way every time, so a timer would only repeat
  // it — and a 401 must leave sync paused, not poll the server.
  it.each(PERMANENT)('never schedules one after %s', (_, err) => {
    expect(isTransientSyncFailure(err)).toBe(false);
  });
});

describe('isSecondPassFailure', () => {
  it('runs a transfer again for what a fresh try in the same cycle can fix', () => {
    for (const err of [
      new BlobRequestError('PUT', 503),
      new BlobRequestError('GET', 403),
      new BlobTimeoutError('PUT', 60_000),
      new BlobNetworkError('GET', new Error('lost')),
    ]) {
      expect(isSecondPassFailure(err)).toBe(true);
    }
  });

  // The second pass is a subset of the timer's cases: an api call has spent
  // L1 already, and a browser's TypeError is the web engine's to add.
  it('is a strict subset of the transient failures', () => {
    for (const [, err] of [...TRANSIENT, ...PERMANENT]) {
      if (isSecondPassFailure(err)) expect(isTransientSyncFailure(err)).toBe(true);
    }
    expect(isSecondPassFailure(new ApiError(500, ''))).toBe(false);
    expect(isSecondPassFailure(new BlobRequestError('GET', 404))).toBe(false);
  });
});

describe('jitteredSyncDelayMs', () => {
  it('moves a wait by at most the jitter, either way', () => {
    expect(jitteredSyncDelayMs(10_000, () => 0)).toBe(10_000 * (1 - SYNC_RETRY_JITTER));
    expect(jitteredSyncDelayMs(10_000, () => 0.5)).toBe(10_000);
    expect(jitteredSyncDelayMs(10_000, () => 1)).toBe(10_000 * (1 + SYNC_RETRY_JITTER));
  });
});

// A clock the scheduler's seams run on: timers fire only when the spec says.
function fakeClock() {
  let at = 0;
  let next = 1;
  const timers = new Map<number, { due: number; fire: () => void }>();
  return {
    now: () => at,
    setTimer: (fire: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { due: at + ms, fire });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    // The waits currently scheduled, from now.
    waits: () => [...timers.values()].map((t) => t.due - at),
    advance(ms: number) {
      at += ms;
      for (const [id, t] of [...timers]) {
        if (t.due > at) continue;
        timers.delete(id);
        t.fire();
      }
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createSyncRetryScheduler', () => {
  function setup() {
    const clock = fakeClock();
    const run = jest.fn();
    const scheduler = createSyncRetryScheduler({
      run,
      now: clock.now,
      random: () => 0.5, // no jitter: the waits are the schedule's own
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const fail = async (err: unknown = new ApiError(503, '')) => {
      scheduler.watch(Promise.reject(err));
      await settle();
    };
    const succeed = async () => {
      scheduler.watch(Promise.resolve());
      await settle();
    };
    return { clock, run, scheduler, fail, succeed };
  }

  it('steps through the schedule after each transient failure, and repeats its last wait', async () => {
    const { clock, run, fail } = setup();
    const waits: number[] = [];
    for (let i = 0; i < SYNC_RETRY_DELAYS_MS.length + 2; i++) {
      await fail();
      waits.push(...clock.waits());
      clock.advance(clock.waits()[0]);
    }

    const last = SYNC_RETRY_DELAYS_MS[SYNC_RETRY_DELAYS_MS.length - 1];
    expect(waits).toEqual([...SYNC_RETRY_DELAYS_MS, last, last]);
    expect(run).toHaveBeenCalledTimes(waits.length);
  });

  it('starts over after a clean cycle, with nothing left pending', async () => {
    const { clock, scheduler, fail, succeed } = setup();
    await fail();
    clock.advance(clock.waits()[0]);
    await fail();
    expect(clock.waits()).toEqual([SYNC_RETRY_DELAYS_MS[1]]);

    // A cycle the person or a write started in the meantime, and it worked.
    await succeed();
    expect(scheduler.pending).toBe(false);

    await fail();
    expect(clock.waits()).toEqual([SYNC_RETRY_DELAYS_MS[0]]);
  });

  it('schedules nothing after a failure no retry can fix', async () => {
    const { clock, scheduler, fail } = setup();
    await fail(new ApiError(401, '{"error":"session_expired"}'));
    expect(scheduler.pending).toBe(false);
    expect(clock.waits()).toEqual([]);

    // And drops one already pending: the newer failure is the one on screen.
    await fail();
    expect(scheduler.pending).toBe(true);
    await fail(new ApiError(400, ''));
    expect(scheduler.pending).toBe(false);
  });

  // Every caller that joins a running cycle shares its promise
  // (runIncrementalSync's single flight), and the provider watches each call.
  // Counted per caller, one failure would climb the backoff several steps.
  it('counts a cycle shared by several callers once', async () => {
    const { clock, scheduler } = setup();
    const cycle = Promise.reject(new ApiError(503, ''));
    scheduler.watch(cycle);
    scheduler.watch(cycle);
    scheduler.watch(cycle);
    await settle();

    expect(clock.waits()).toEqual([SYNC_RETRY_DELAYS_MS[0]]);
  });

  it('starts a pending retry at once on a wake-up, at most every so often', async () => {
    const { clock, run, scheduler, fail } = setup();
    await fail();
    clock.advance(SYNC_RETRY_DELAYS_MS[0]);
    await fail(); // now waiting out the second step

    scheduler.wake();
    expect(run).toHaveBeenCalledTimes(2);
    expect(scheduler.pending).toBe(false);

    // The woken cycle failed again; a second wake-up inside the interval waits
    // for the schedule instead of starting another.
    await fail();
    scheduler.wake();
    expect(run).toHaveBeenCalledTimes(2);
    clock.advance(SYNC_WAKE_MIN_INTERVAL_MS);
    scheduler.wake();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('starts nothing on a wake-up with no retry pending', async () => {
    const { run, scheduler, succeed } = setup();
    scheduler.wake();
    await succeed();
    scheduler.wake();
    expect(run).not.toHaveBeenCalled();
  });

  it('stops for good once disposed', async () => {
    const { clock, run, scheduler, fail } = setup();
    await fail();
    scheduler.dispose();
    clock.advance(SYNC_RETRY_DELAYS_MS[0]);
    await fail();
    scheduler.wake();

    expect(run).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(false);
  });
});

describe('runInitialSyncWithRetries', () => {
  function attempts(...outcomes: (Error | undefined)[]) {
    let calls = 0;
    return {
      attempt: async () => {
        const err = outcomes[calls++];
        if (err) throw err;
      },
      calls: () => calls,
    };
  }
  const options = (sleeps: number[], stillWanted = () => true) => ({
    onRetry: jest.fn(),
    sleep: async (ms: number) => void sleeps.push(ms),
    stillWanted,
    random: () => 0.5,
  });

  it('retries a transient failure on its short schedule, and resolves once one lands', async () => {
    const sleeps: number[] = [];
    const { attempt, calls } = attempts(new ApiError(503, ''), new BlobTimeoutError('GET', 1));
    const opts = options(sleeps);

    await expect(runInitialSyncWithRetries(attempt, opts)).resolves.toBeUndefined();
    expect(calls()).toBe(3);
    expect(sleeps).toEqual(INITIAL_SYNC_RETRY_DELAYS_MS.slice(0, 2));
    expect(opts.onRetry.mock.calls).toEqual([[1], [2]]);
  });

  it('gives up after its last retry, with the last failure — the gate’s button is next', async () => {
    const last = new ApiError(502, '');
    const failures = INITIAL_SYNC_RETRY_DELAYS_MS.map(() => new ApiError(503, ''));
    const { attempt, calls } = attempts(...failures, last);

    await expect(runInitialSyncWithRetries(attempt, options([]))).rejects.toBe(last);
    expect(calls()).toBe(INITIAL_SYNC_RETRY_DELAYS_MS.length + 1);
  });

  it('does not retry what a retry cannot fix', async () => {
    const refused = new ApiError(401, '{"error":"session_expired"}');
    const { attempt, calls } = attempts(refused);
    const opts = options([]);

    await expect(runInitialSyncWithRetries(attempt, opts)).rejects.toBe(refused);
    expect(calls()).toBe(1);
    expect(opts.onRetry).not.toHaveBeenCalled();
  });

  it('stops without another attempt once the caller has moved on', async () => {
    const { attempt, calls } = attempts(new ApiError(503, ''));

    await expect(
      runInitialSyncWithRetries(
        attempt,
        options([], () => false),
      ),
    ).resolves.toBeUndefined();
    expect(calls()).toBe(1);
  });
});
