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
});
