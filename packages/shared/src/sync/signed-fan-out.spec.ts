// Specs for the pull's fan-out (signed-fan-out.ts): the cap, signing one batch
// ahead and never more, a feed that arrives in pieces, and the failure policy.
// Driven by deferreds rather than timers, as async/pool.spec.ts is: the
// interleavings are what is under test.

import { createSignedFanOut } from './signed-fan-out';

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = (): Promise<void> => new Promise((res) => setImmediate(res));

const entries = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ path: `links/l_${from + i}.enc` }));

// A sign that answers every path with its own name, and records each call.
function recordingSign() {
  const calls: string[][] = [];
  const sign = async (paths: string[]) => {
    calls.push(paths);
    return new Map(paths.map((p) => [p, `url:${p}`]));
  };
  return { calls, sign };
}

describe('createSignedFanOut', () => {
  it('runs every entry with its own signed value, never past `concurrency` at once', async () => {
    const { sign } = recordingSign();
    const ran: [string, string | undefined][] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fanOut = createSignedFanOut({
      concurrency: 3,
      signBatch: 4,
      sign,
      run: async (entry, signed) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await flush();
        ran.push([entry.path, signed]);
        inFlight -= 1;
      },
    });

    fanOut.add(entries(10));
    await fanOut.close();

    expect(ran.map(([p]) => p).sort()).toEqual(
      entries(10)
        .map((e) => e.path)
        .sort(),
    );
    expect(ran.every(([p, signed]) => signed === `url:${p}`)).toBe(true);
    expect(maxInFlight).toBe(3);
  });

  it('signs in batches of `signBatch`, one ahead of the transfers and never more', async () => {
    const { calls, sign } = recordingSign();
    const gates = new Map<string, Deferred>();
    const fanOut = createSignedFanOut({
      concurrency: 2,
      signBatch: 6,
      sign,
      run: async (entry) => {
        const gate = deferred();
        gates.set(entry.path, gate);
        await gate.promise;
      },
    });

    fanOut.add(entries(20));
    await flush();
    // One batch signed and two transfers taken from it, four left signed: the
    // next batch waits until fewer than two rounds (2 × concurrency) are left.
    expect(calls.map((c) => c.length)).toEqual([6]);

    for (const gate of gates.values()) gate.resolve();
    await flush();
    // Two more taken, two left signed: the next batch is asked for — and the one
    // after it is not, with eight signed again.
    expect(calls.map((c) => c.length)).toEqual([6, 6]);

    const finishAll = async () => {
      for (;;) {
        const open = [...gates.values()];
        open.forEach((g) => g.resolve());
        await flush();
        if ([...gates.values()].length === open.length) return;
      }
    };
    const closed = fanOut.close();
    await finishAll();
    await closed;
    expect(calls.map((c) => c.length)).toEqual([6, 6, 6, 2]);
  });

  it('starts on the first entries while more are still being added', async () => {
    const { sign } = recordingSign();
    const ran: string[] = [];
    const fanOut = createSignedFanOut({
      concurrency: 4,
      signBatch: 10,
      sign,
      run: async (entry) => {
        ran.push(entry.path);
      },
    });

    fanOut.add(entries(3));
    await flush();
    // Nothing has closed the feed, and the first page is already done.
    expect(ran).toHaveLength(3);

    fanOut.add(entries(3, 3));
    await fanOut.close();
    expect(ran).toHaveLength(6);
  });

  it('passes undefined for a path the sign call did not answer', async () => {
    const seen: (string | undefined)[] = [];
    const fanOut = createSignedFanOut({
      concurrency: 2,
      signBatch: 10,
      sign: async (paths) => new Map(paths.slice(1).map((p) => [p, 'url'])),
      run: async (_entry, signed) => {
        seen.push(signed);
      },
    });

    fanOut.add(entries(3));
    await fanOut.close();
    expect(seen.filter((s) => s === undefined)).toHaveLength(1);
  });

  it('stops starting entries after a failed run, and rejects close with it', async () => {
    const { sign } = recordingSign();
    const boom = new Error('GET failed');
    const ran: string[] = [];
    const fanOut = createSignedFanOut({
      concurrency: 1,
      signBatch: 10,
      sign,
      run: async (entry) => {
        ran.push(entry.path);
        if (ran.length === 2) throw boom;
      },
    });

    fanOut.add(entries(5));
    await expect(fanOut.close()).rejects.toBe(boom);
    expect(ran).toHaveLength(2);
  });

  it('fails on a sign that rejects, and refuses further entries with it', async () => {
    const boom = new Error('sign failed');
    const run = jest.fn(async () => undefined);
    const fanOut = createSignedFanOut({
      concurrency: 2,
      signBatch: 10,
      sign: async () => {
        throw boom;
      },
      run,
    });

    fanOut.add(entries(3));
    await flush();
    // A feed still listing learns of it on its next page.
    expect(() => fanOut.add(entries(1, 3))).toThrow(boom);
    await expect(fanOut.close()).rejects.toBe(boom);
    expect(run).not.toHaveBeenCalled();
  });

  it('stops on abandon, letting the transfer in flight settle', async () => {
    const { sign } = recordingSign();
    const gate = deferred();
    const ran: string[] = [];
    const fanOut = createSignedFanOut({
      concurrency: 1,
      signBatch: 10,
      sign,
      run: async (entry) => {
        ran.push(entry.path);
        await gate.promise;
      },
    });
    const reason = new Error('listing failed');

    fanOut.add(entries(3));
    await flush();
    fanOut.abandon(reason);
    gate.resolve();

    await expect(fanOut.close()).rejects.toBe(reason);
    expect(ran).toHaveLength(1);
  });

  it('settles abandon only once the transfer in flight has', async () => {
    // A caller that rethrows after abandoning must not return with a transfer still
    // writing behind it (the engines' feedPull, for a first sync's retry).
    const { sign } = recordingSign();
    const gate = deferred();
    let settled = false;
    const fanOut = createSignedFanOut({
      concurrency: 1,
      signBatch: 10,
      sign,
      run: async () => {
        await gate.promise;
        settled = true;
      },
    });

    fanOut.add(entries(3));
    await flush();
    let abandoned = false;
    const abandoning = fanOut.abandon(new Error('listing failed')).then(() => {
      abandoned = true;
    });
    await flush();
    expect(abandoned).toBe(false);

    gate.resolve();
    await abandoning;
    expect(settled).toBe(true);
  });

  it('resolves close at once when nothing was added', async () => {
    const sign = jest.fn(async () => new Map<string, string>());
    const fanOut = createSignedFanOut({ concurrency: 4, signBatch: 10, sign, run: jest.fn() });

    await expect(fanOut.close()).resolves.toBeUndefined();
    expect(sign).not.toHaveBeenCalled();
  });

  it.each([
    ['concurrency', { concurrency: 0, signBatch: 1 }],
    ['signBatch', { concurrency: 1, signBatch: 0 }],
  ])('refuses a %s that is not a positive integer', (_name, sizes) => {
    expect(() =>
      createSignedFanOut({ ...sizes, sign: async () => new Map(), run: async () => undefined }),
    ).toThrow(RangeError);
  });
});
