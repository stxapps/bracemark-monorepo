import { chunk } from './chunk';

describe('chunk', () => {
  it('splits into contiguous batches of at most `size`', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one batch when the array fits within `size`', () => {
    expect(chunk([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
  });

  it('returns an exact split with no trailing empty batch', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('returns no batches for an empty array', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  // The examples above are three sizes against one length. The callers' actual
  // requirement is the invariant at EVERY size: `IN_BATCH` exists to keep an
  // `IN (...)`/multi-row insert under SQLite's bound-variable ceiling, so a batch
  // that comes back longer than `size` is a bound-variable overflow at runtime,
  // and a batch that comes back empty is a degenerate statement.
  it('upholds the partition invariant at every size', () => {
    const arr = [1, 2, 3, 4, 5, 6, 7];

    for (let size = 1; size <= arr.length + 2; size++) {
      const batches = chunk(arr, size);

      expect(batches.flat()).toEqual(arr); // every element, once, in order
      expect(batches.length).toBe(Math.ceil(arr.length / size));
      for (const batch of batches) {
        expect(batch.length).toBeGreaterThan(0);
        expect(batch.length).toBeLessThanOrEqual(size);
      }
      // Only the last batch may be short — the callers walk batches expecting a
      // full request/statement until the tail.
      for (const batch of batches.slice(0, -1)) expect(batch.length).toBe(size);
    }
  });

  it('copies into new batches without mutating or cloning', () => {
    // The batches must be fresh arrays (an in-place `splice` implementation would
    // pass every example above while emptying the caller's list mid-loop), but the
    // ELEMENTS must be the same references — callers hand a batch straight to
    // `tx.insert(...).values(batch)` and to the sync request bodies.
    const a = { path: 'a' };
    const b = { path: 'b' };
    const arr = [a, b];

    const batches = chunk(arr, 1);

    expect(arr).toEqual([a, b]);
    expect(batches[0]).not.toBe(arr);
    expect(batches[0][0]).toBe(a);
    expect(batches[1][0]).toBe(b);
  });

  // Every current call site passes a literal (500, 1000) or `Math.min` of two,
  // so this only ever fires on a newly DERIVED size — a ceiling divided by
  // columns-per-row, say. Each of the three used to fail differently and
  // silently: 0 and negatives never advance the cursor (an unbounded loop
  // allocating until the tab or app dies), NaN ran the body once with a single
  // EMPTY batch (dropping every element while looking like it worked), and a
  // fraction emitted batches LARGER than `size` — `chunk([a, b, c, d], 1.5)`
  // returned `[[a], [b, c], [d]]`, breaking the one guarantee the SQLite callers
  // rely on.
  describe('rejects a size that is not a positive integer', () => {
    it.each([0, -1, -500, 1.5, 2.5, NaN, Infinity])('throws on %p', (size) => {
      expect(() => chunk([1, 2, 3], size)).toThrow(RangeError);
    });

    it('throws rather than treating an empty array as nothing to validate', () => {
      // Otherwise the bad size hides until the first non-empty call.
      expect(() => chunk([], 0)).toThrow(RangeError);
    });
  });
});
