import {
  compareRank,
  placeAtIndex,
  rankBetween,
  rankForIndex,
  ranksBetween,
  rerankToOrder,
} from './rank';

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

describe('placeAtIndex', () => {
  type Row = { id: string; rank: string };
  const row = (id: string, rank: string): Row => ({ id, rank });

  // What a caller does with a placement, one write at a time: `shifted` in the
  // order given, then the placed row. Returns the ids as the sort would render
  // them after EACH write, so a test can read the final order and every order
  // painted on the way there.
  const write = (group: Row[], index: number, placed: Row): string[][] => {
    const { rank, shifted } = placeAtIndex(group, index);
    const store = new Map([...group, placed].map((r) => [r.id, r.rank]));
    const order = () =>
      [...store.entries()]
        .map(([id, r]) => row(id, r))
        .sort(compareRank)
        .map((r) => r.id);

    const orders: string[][] = [];
    for (const { item, rank: next } of [...shifted, { item: placed, rank }]) {
      store.set(item.id, next);
      orders.push(order());
    }
    return orders;
  };

  const inserted = (group: Row[], index: number, id: string): string[] => {
    const ids = group.map((r) => r.id);
    ids.splice(index, 0, id);
    return ids;
  };

  it('is rankForIndex, and one write, wherever no tie is in the way', () => {
    const group = [row('a', k[1]), row('b', k[2]), row('c', k[3])];
    for (let index = 0; index <= group.length; index++) {
      expect(placeAtIndex(group, index)).toEqual({
        rank: rankForIndex(group, index),
        shifted: [],
      });
    }
    // Out of range clamps, as rankForIndex does.
    expect(placeAtIndex(group, 99).rank).toBe(rankForIndex(group, group.length));
    expect(placeAtIndex(group, -5).rank).toBe(rankForIndex(group, 0));
    expect(placeAtIndex([], 0)).toEqual({ rank: rankBetween(null, null), shifted: [] });
  });

  it('lands between two tied keys, where rankForIndex throws', () => {
    // The specimen: a library whose root lists were ranked from the same starting
    // point as the system-list defaults, so `engineering` and `trash` shared a
    // key. "Move up" on the row under Trash asked for the slot between them and
    // the settings table printed fractional-indexing's bare " >= ".
    const group = [
      row('my-list', k[0]),
      row('engineering', k[2]),
      row('trash', k[2]),
      row('personal', k[4]),
    ];
    expect(() => rankForIndex(group, 2)).toThrow();

    const orders = write(group, 2, row('design', k[3]));
    expect(orders.at(-1)).toEqual(inserted(group, 2, 'design'));
    // The moved row and ONE of the tied pair — not the group.
    expect(orders).toHaveLength(2);
  });

  it('splits a tie at either end of the group, and when the placed row is tied too', () => {
    const tiedPair = [row('a', k[2]), row('b', k[2])];
    // Nothing on either side of the pair to mint against but the open ends.
    expect(write(tiedPair, 1, row('m', k[4])).at(-1)).toEqual(['a', 'm', 'b']);
    // The placed row carries the tied key itself and sorts last of the three.
    expect(write(tiedPair, 1, row('z', k[2])).at(-1)).toEqual(['a', 'z', 'b']);
    // A slot BESIDE the pair is not between tied keys: one write.
    expect(placeAtIndex(tiedPair, 0).shifted).toEqual([]);
    expect(placeAtIndex(tiedPair, 2).shifted).toEqual([]);
  });

  it('re-keys the shorter side of a longer tied run, at every slot inside it', () => {
    // Five rows on one key — a stale snapshot minting several heads against the
    // same neighbour — between two rows that are not tied.
    const group = [
      row('lo', k[0]),
      ...['a', 'b', 'c', 'd', 'e'].map((id) => row(id, k[2])),
      row('hi', k[4]),
    ];
    for (let index = 2; index <= 5; index++) {
      const { shifted } = placeAtIndex(group, index);
      // The slot sits `index - 1` rows into the run, `6 - index` from its end.
      expect(shifted).toHaveLength(Math.min(index - 1, 6 - index));
      // Only tied rows are ever re-keyed — never the neighbours of the run.
      for (const { item } of shifted) expect(item.rank).toBe(k[2]);

      const orders = write(group, index, row('m', k[3]));
      expect(orders.at(-1)).toEqual(inserted(group, index, 'm'));
    }
  });

  it('never reorders the siblings on the way — only the placed row moves', () => {
    // Each write is its own transaction and its own repaint. Written in the
    // order `shifted` comes in, the siblings hold their order through every one
    // of them, so the only change a live read paints is the move itself.
    const group = [
      row('lo', k[0]),
      ...['a', 'b', 'c', 'd', 'e'].map((id) => row(id, k[2])),
      row('hi', k[4]),
    ];
    const siblingIds = group.map((r) => r.id);
    for (let index = 2; index <= 5; index++) {
      // Placed from above the run, from below it, and from inside the tie.
      for (const from of [row('m', k[1]), row('m', k[3]), row('m', k[2])]) {
        for (const order of write(group, index, from)) {
          expect(order.filter((id) => id !== 'm')).toEqual(siblingIds);
        }
      }
    }
  });
});
