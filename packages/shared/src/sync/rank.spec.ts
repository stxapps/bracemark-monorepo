import { rankBetween, rankForIndex, ranksBetween, rerankToOrder } from './rank';

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
    // Desired order carries ranks k0, k2, k3, k1: only the trailing item is out
    // of place (k1 < k3), so only it is re-ranked.
    const ordered = [{ rank: k[0] }, { rank: k[2] }, { rank: k[3] }, { rank: k[1] }];
    const plan = rerankToOrder(ordered);
    expect(plan.slice(0, 3)).toEqual([null, null, null]);
    expect(plan[3]).not.toBeNull();
    expect(isStrictlyAscending(applied(ordered))).toBe(true);
  });

  it('re-ranks a fully reversed group into ascending order', () => {
    const ordered = [{ rank: k[4] }, { rank: k[3] }, { rank: k[2] }, { rank: k[1] }];
    expect(isStrictlyAscending(applied(ordered))).toBe(true);
    // No two of them are in order, so exactly one can anchor the rest.
    expect(rerankToOrder(ordered).filter((rank) => rank === null)).toHaveLength(1);
  });

  it('writes one key for a one-row move, whichever way the row went', () => {
    // The drag surfaces hand over the whole group in its new order, so a single
    // moved row arrives as one stray among n − 1 rows still in order. Picking the
    // anchors from the head got this right downward and wrong upward: the row
    // carried to the top became the leading anchor and every row under it was
    // re-ranked — n − 1 writes, and a repaint of the table per write.
    const group = k.map((rank) => ({ rank }));
    for (let from = 0; from < group.length; from++) {
      for (let to = 0; to < group.length; to++) {
        if (from === to) continue;
        const ordered = group.slice();
        const [moved] = ordered.splice(from, 1);
        ordered.splice(to, 0, moved);

        const plan = rerankToOrder(ordered);
        expect(plan.filter((rank) => rank !== null)).toHaveLength(1);
        expect(isStrictlyAscending(applied(ordered))).toBe(true);
      }
    }
  });

  it('anchors on at most one of two tied keys', () => {
    // Concurrent inserts at one slot can mint the same key (the header). A tie is
    // not an order, so keeping both would leave the group not strictly ascending.
    const ordered = [{ rank: k[0] }, { rank: k[2] }, { rank: k[2] }, { rank: k[3] }];
    expect(isStrictlyAscending(applied(ordered))).toBe(true);
    expect(rerankToOrder(ordered).filter((rank) => rank !== null)).toHaveLength(1);
  });

  it('fills a run of strays between two anchors with evenly-spaced keys', () => {
    // k2, k3 (keep), two strays whose ranks fall below both and are themselves
    // reversed, then k4 (keep): the strays land between the k3 and k4 anchors.
    // (With a single leading anchor the strays would be the longer run, and the
    // anchor would be the one to move.)
    const ordered = [
      { rank: k[2] },
      { rank: k[3] },
      { rank: k[1] },
      { rank: k[0] },
      { rank: k[4] },
    ];
    const plan = rerankToOrder(ordered);
    expect(plan[0]).toBeNull();
    expect(plan[1]).toBeNull();
    expect(plan[4]).toBeNull();
    expect(plan[2]).not.toBeNull();
    expect(plan[3]).not.toBeNull();
    expect(isStrictlyAscending(applied(ordered))).toBe(true);
  });

  it('handles empty and single-item groups', () => {
    expect(rerankToOrder([])).toEqual([]);
    expect(rerankToOrder([{ rank: k[0] }])).toEqual([null]);
  });
});

describe('rankForIndex', () => {
  // The one helper a reorder/move UI calls: "drop at position i" → the key to
  // persist on the moved entity, with nothing else rewritten.
  const siblings = [{ rank: k[1] }, { rank: k[2] }, { rank: k[3] }];

  it('mints a key that lands the entity at the requested slot', () => {
    for (let index = 0; index <= siblings.length; index++) {
      const minted = rankForIndex(siblings, index);
      const after = [...siblings.map((s) => s.rank)];
      after.splice(index, 0, minted);
      expect(isStrictlyAscending(after)).toBe(true);
    }
  });

  it('prepends at 0 and appends at length', () => {
    expect(rankForIndex(siblings, 0) < k[1]).toBe(true);
    expect(rankForIndex(siblings, siblings.length) > k[3]).toBe(true);
  });

  it('opens both ends for an empty group', () => {
    expect(rankForIndex([], 0)).toBe(rankBetween(null, null));
  });

  it('clamps an out-of-range index instead of reading past the array', () => {
    // A drag surface computes the index from a hit test, so an off-by-one at the
    // ends is ordinary. Unclamped, `siblings[i - 1]` / `siblings[i]` is undefined
    // and this throws a TypeError mid-drop — the user's move is lost and the
    // error surfaces nowhere near the cause.
    expect(rankForIndex(siblings, 99)).toBe(rankForIndex(siblings, siblings.length));
    expect(rankForIndex(siblings, -5)).toBe(rankForIndex(siblings, 0));
  });

  it('leaves the neighbours untouched — the whole point of a fractional key', () => {
    // Under file-level LWW a move must write ONE file. If this renumbered
    // siblings, every move would be several LWW points and two devices moving
    // two different entities would clobber each other.
    const before = siblings.map((s) => s.rank);
    rankForIndex(siblings, 1);
    expect(siblings.map((s) => s.rank)).toEqual(before);
  });
});
