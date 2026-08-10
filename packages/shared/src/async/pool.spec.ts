// Specs for the pool's two contracts: the CAP (never more than `limit` in flight)
// and the FAILURE POLICY (a throw from `fn` fails the pool and abandons the rest of
// the queue). The second is the load-bearing one — the sync engines' upload loops
// catch per item precisely so their own failures DON'T reach the pool, so a change
// here that silently swallowed a rejection would turn a failed cycle into a clean
// one, which is exactly the false 'idle' the engine work went in to prevent.
//
// Driven by deferreds rather than timers: the interleavings under test are the
// point, and a timer would race the test against the thing it's measuring.

import { mapLimit } from './pool';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Let every already-scheduled microtask run, so "what has the pool picked up by
// now" is a settled question at the point the assertion reads it.
const flush = (): Promise<void> => new Promise((res) => setImmediate(res));

describe('mapLimit', () => {
  it('runs every item and never exceeds `limit` in flight', async () => {
    const gates = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const done = mapLimit([0, 1, 2, 3, 4], 2, async (i) => {
      started.push(i);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[i].promise;
      inFlight -= 1;
    });

    // Only `limit` are picked up: the other three are still queued behind them.
    await flush();
    expect(started).toEqual([0, 1]);

    // A finished item frees exactly one slot, which the next queued item takes.
    gates[0].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates.forEach((g) => g.resolve());
    await done;
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(maxInFlight).toBe(2);
  });

  it('spawns no more workers than there are items', async () => {
    const calls: number[] = [];

    await mapLimit([1, 2], 8, async (n) => {
      calls.push(n);
    });

    expect(calls).toEqual([1, 2]);
  });

  it('resolves without calling `fn` for an empty list', async () => {
    const fn = jest.fn(async () => undefined);

    await expect(mapLimit([], 4, fn)).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects with the first error and abandons the rest of the queue', async () => {
    const boom = new Error('item b failed');
    const started: string[] = [];

    await expect(
      mapLimit(['a', 'b', 'c', 'd', 'e'], 1, async (item) => {
        started.push(item);
        if (item === 'b') throw boom;
      }),
    ).rejects.toBe(boom);

    // c/d/e were never started — the point of the policy: stop feeding work into a
    // cycle that is already failing, rather than grinding the whole queue through a
    // dead network and reporting one error at the end.
    expect(started).toEqual(['a', 'b']);
  });

  it('rejects as soon as an item fails, without cancelling the ones in flight', async () => {
    const boom = new Error('fast failure');
    const slow = deferred();
    let slowFinished = false;

    const done = mapLimit(['fail', 'slow'], 2, async (item) => {
      if (item === 'fail') throw boom;
      await slow.promise;
      slowFinished = true;
    });

    // The pool rejects on the FIRST rejection rather than waiting for the rest, so
    // the caller learns of the failure while `slow` is still in flight.
    await expect(done).rejects.toBe(boom);
    expect(slowFinished).toBe(false);

    // And that straggler is not cancelled — nothing here can interrupt an
    // already-started `fn`, so it settles on its own AFTER the caller has moved on.
    // Anything a caller does on rejection has to tolerate that late completion; the
    // engines' upload loops do, by catching per op so a failure never reaches the
    // pool at all (sync/engine.ts uploadBlobs).
    slow.resolve();
    await flush();
    expect(slowFinished).toBe(true);
  });

  it('observes every worker rejection, not only the one it rethrows', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      const first = new Error('worker A');
      const second = new Error('worker B');

      // Both workers pick up a failing item before either rejection settles, so the
      // pool holds TWO rejected worker promises and rethrows only the first. They
      // are still all awaited together (Promise.all subscribes to every one), which
      // is what keeps the loser from surfacing as an unhandled rejection — a crash
      // in bracemark-web, not a caught sync error.
      await expect(
        mapLimit([first, second], 2, async (err) => {
          await Promise.resolve();
          throw err;
        }),
      ).rejects.toBe(first);

      // An unhandled rejection is reported a turn after the microtask queue drains.
      await new Promise((res) => setTimeout(res, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
