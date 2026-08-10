import { ranksBetween, rerankToOrder } from './rank';

// A pool of five real, ascending fractional-index keys (k[0] < … < k[4]).
// rerankToOrder validates its bounds as genuine order keys, so inputs must be
// built from real keys — never bare letters.
const k = ranksBetween(null, null, 5);

// Apply a rerankToOrder result back onto the input to get the final rank each
// item ends up with (its minted key, or its kept current key), so a test can
// assert the group is left strictly ascending in the desired order.
const applied = (ordered: { rank: string }[]): string[] => {
  const plan = rerankToOrder(ordered);
  return ordered.map((item, i) => plan[i] ?? item.rank);
};

const isStrictlyAscending = (ranks: string[]): boolean =>
  ranks.every((rank, i) => i === 0 || ranks[i - 1] < rank);

describe('rerankToOrder', () => {
  it('is a no-op when the group is already in order', () => {
    const ordered = [{ rank: k[0] }, { rank: k[1] }, { rank: k[2] }];
    expect(rerankToOrder(ordered)).toEqual([null, null, null]);
  });

  it('keeps in-order items as anchors and re-ranks only the strays', () => {
    // Desired order carries ranks k0, k3, k1: only the trailing item is out of
    // place (k1 < k3), so only it is re-ranked.
    const ordered = [{ rank: k[0] }, { rank: k[3] }, { rank: k[1] }];
    const plan = rerankToOrder(ordered);
    expect(plan[0]).toBeNull();
    expect(plan[1]).toBeNull();
    expect(plan[2]).not.toBeNull();
    expect(isStrictlyAscending(applied(ordered))).toBe(true);
  });

  it('re-ranks a fully reversed group into ascending order', () => {
    const ordered = [{ rank: k[4] }, { rank: k[3] }, { rank: k[2] }, { rank: k[1] }];
    expect(isStrictlyAscending(applied(ordered))).toBe(true);
    // The first item is always kept as the leading anchor; the rest are minted.
    expect(rerankToOrder(ordered)[0]).toBeNull();
  });

  it('fills a run of strays between two anchors with evenly-spaced keys', () => {
    // k2 (keep), two strays whose ranks fall below it, then k4 (keep): the
    // strays land between the k2 and k4 anchors.
    const ordered = [{ rank: k[2] }, { rank: k[0] }, { rank: k[1] }, { rank: k[4] }];
    const plan = rerankToOrder(ordered);
    expect(plan[0]).toBeNull();
    expect(plan[3]).toBeNull();
    expect(plan[1]).not.toBeNull();
    expect(plan[2]).not.toBeNull();
    expect(isStrictlyAscending(applied(ordered))).toBe(true);
  });

  it('handles empty and single-item groups', () => {
    expect(rerankToOrder([])).toEqual([]);
    expect(rerankToOrder([{ rank: k[0] }])).toEqual([null]);
  });
});
