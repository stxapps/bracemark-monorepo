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

  it('serializes completely at `limit` 1', async () => {
    const gates = Array.from({ length: 3 }, deferred);
    const started: number[] = [];

    const done = mapLimit([0, 1, 2], 1, async (i) => {
      started.push(i);
      await gates[i].promise;
    });

    await flush();
    expect(started).toEqual([0]);

    gates.forEach((g) => g.resolve());
    await done;
    expect(started).toEqual([0, 1, 2]);
  });

  it('runs an `undefined` item instead of mistaking it for an exhausted queue', async () => {
    // The drain loop cannot use `undefined` as its end sentinel: `T` is generic,
    // so an `undefined` item is legal, and treating one as "nothing left" halted
    // every worker early while the pool STILL resolved — a partial pass reported
    // as a complete one, with no error anywhere. The sync engines size their
    // next cycle off "this cycle finished", so a silent short pass is worse here
    // than a loud failure.
    const seen: unknown[] = [];

    await mapLimit(['a', undefined, 'c', 'd'], 1, async (item) => {
      seen.push(item);
    });

    expect(seen).toEqual(['a', undefined, 'c', 'd']);
  });

  it('runs the holes of a sparse list rather than stopping at the first', async () => {
    let calls = 0;

    await mapLimit(new Array(3), 2, async () => {
      calls += 1;
    });

    expect(calls).toBe(3);
  });

  // `Math.min(limit, n)` turns a non-positive limit into ZERO workers, so the pool
  // resolved cleanly having called `fn` not once — every item skipped, reported as
  // a successful pass. That is the same false 'idle' this file's failure policy
  // exists to prevent, arriving through the argument instead of the queue.
  describe('rejects a limit that is not a positive integer', () => {
    // `mapLimit` is async, so the refusal arrives as a rejection — the shape every
    // call site already awaits, rather than a sync throw only some would catch.
    it.each([0, -1, 1.5, NaN, Infinity])('rejects on %p', async (limit) => {
      const fn = jest.fn(async () => undefined);

      await expect(mapLimit([1, 2, 3], limit, fn)).rejects.toThrow(RangeError);
      expect(fn).not.toHaveBeenCalled();
    });

    it('rejects rather than treating an empty list as nothing to validate', async () => {
      // Otherwise the bad limit hides until the first non-empty batch.
      await expect(mapLimit([], 0, async () => undefined)).rejects.toThrow(RangeError);
    });
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
