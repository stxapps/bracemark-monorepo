// The three helpers every progress readout runs through. Each guards a failure
// that is invisible in code review and obvious only on a slow, large sync:
//   - the COALESCER is what keeps a per-unit feed (hundreds a second) from
//     becoming hundreds of renders — and its trailing edge is what keeps a
//     one-change cycle from flashing a bar it finished before anyone could read;
//   - the UNIT COUNTER is what keeps a push's second pass from counting an op
//     twice and running the readout past its own total;
//   - the PERCENT is what keeps "100%" from appearing beside "996 of 1,000".

import { createProgressCoalescer, createUnitCounter, progressPercent } from './progress';

describe('createProgressCoalescer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('turns a burst of ticks into one flush, carrying the latest', () => {
    const flushed: number[] = [];
    const c = createProgressCoalescer<number>((v) => flushed.push(v), 100);

    for (let i = 1; i <= 50; i++) c.report(i);
    expect(flushed).toEqual([]);

    jest.advanceTimersByTime(100);
    expect(flushed).toEqual([50]);
  });

  it('keeps flushing at its interval while ticks keep coming', () => {
    const flushed: number[] = [];
    const c = createProgressCoalescer<number>((v) => flushed.push(v), 100);

    c.report(1);
    jest.advanceTimersByTime(100);
    c.report(2);
    jest.advanceTimersByTime(100);

    expect(flushed).toEqual([1, 2]);
  });

  // Trailing, not leading: a job that ends inside one interval paints nothing.
  it('paints nothing for a job cancelled inside its first interval', () => {
    const onFlush = jest.fn();
    const c = createProgressCoalescer<number>(onFlush, 100);

    c.report(1);
    c.cancel();
    jest.advanceTimersByTime(1000);

    expect(onFlush).not.toHaveBeenCalled();
  });

  it('flushes the pending value at once on demand, and only once', () => {
    const flushed: number[] = [];
    const c = createProgressCoalescer<number>((v) => flushed.push(v), 100);

    c.report(7);
    c.flush();
    jest.advanceTimersByTime(1000);

    expect(flushed).toEqual([7]);
  });
});

describe('createUnitCounter', () => {
  it('opens at zero against the full total, then ticks each unit once', () => {
    const ticks: [number, number][] = [];
    const tick = createUnitCounter(3, (d, t) => ticks.push([d, t]));

    tick('a');
    tick('a'); // the second pass re-sending what the first failed
    tick('b');
    tick('c');

    expect(ticks).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('never runs past its total', () => {
    const onProgress = jest.fn();
    const tick = createUnitCounter(1, onProgress);

    tick('a');
    tick('b');

    expect(onProgress).toHaveBeenLastCalledWith(1, 1);
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it('reports nothing for an empty set', () => {
    const onProgress = jest.fn();
    createUnitCounter(0, onProgress)('a');
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('progressPercent', () => {
  it('says 100 only when the last unit has landed', () => {
    expect(progressPercent(996, 1000)).toBe(99);
    expect(progressPercent(999, 1000)).toBe(99);
    expect(progressPercent(1000, 1000)).toBe(100);
  });

  it('survives the inputs a package boundary cannot promise', () => {
    expect(progressPercent(0, 0)).toBe(0);
    expect(progressPercent(5, 0)).toBe(0);
    expect(progressPercent(12, 10)).toBe(100);
  });
});
