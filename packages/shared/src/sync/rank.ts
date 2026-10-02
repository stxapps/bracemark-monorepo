// Fractional-index ordering for lists/tags (entities.ts `rank`). The thin
// platform-agnostic wrapper over `fractional-indexing` so every client mints
// order keys by ONE definition — and so the dep is swappable from here alone.
//
// Why a string key and not an integer position: each entity is its own
// encrypted file under last-writer-wins (docs/local-first-sync.md). With integer
// positions, inserting/moving one entity renumbers its siblings → many file
// writes → many LWW points → concurrent reorders clobber. A fractional key lets
// an insert between neighbours A and B compute `between(A.rank, B.rank)` and
// write ONLY the moved entity's file. A.rank and B.rank are untouched, so two
// devices moving two different entities never conflict.
//
// Keys sort by plain ascending string comparison (`<`), which is all buildTree
// (tree.ts) needs. Concurrent inserts at the same slot can mint equal keys — a
// tie, never data loss — broken deterministically by id in the sort. A tie is
// the one place a move writes more than the moved entity: see `placeAtIndex`.

import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

// The deterministic sibling order every ranked view shares: ascending `rank`,
// ties broken by `id` (concurrent inserts at the same slot can mint equal keys —
// see above). This is the SAME ordering buildTree applies to each sibling group
// (tree.ts), lifted here so callers that pre-sort a flat namespace before
// `rankForIndex` (which reads the neighbours at the target index) and readers
// that order pins use one definition. Generic over any `{ rank, id }` entity —
// lists, tags, pins.
export function compareRank<T extends { rank: string; id: string }>(a: T, b: T): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

// A key ordered strictly between `a` and `b` (ascending). Pass `null` for an
// open end: `between(null, b)` prepends before everything, `between(a, null)`
// appends after everything, `between(null, null)` is the first key in an empty
// group.
export function rankBetween(a: string | null, b: string | null): string {
  return generateKeyBetween(a, b);
}

// `n` evenly-spaced keys strictly between `a` and `b` (ascending). Used to seed a
// batch at once — e.g. the system-list defaults — without n round-trips through
// `rankBetween` (which would degenerate to one side).
export function ranksBetween(a: string | null, b: string | null, n: number): string[] {
  return generateNKeysBetween(a, b, n);
}

// The rank that places an entity at `index` within an already-sorted sibling
// group (the array buildTree produced, MINUS the entity being moved). `index` is
// clamped to `[0, siblings.length]`; 0 prepends, `length` appends. It turns
// "drop at position i" into the key to persist on the placed entity — and
// nothing else is rewritten.
//
// For a PREPEND or an APPEND only (every create, the import's resolvers): one
// end is open there, so a key always exists. A slot in the middle can fall
// between two TIED keys, where no key exists and this throws — a move goes
// through `placeAtIndex`, below.
export function rankForIndex(siblings: { rank: string }[], index: number): string {
  const i = Math.max(0, Math.min(index, siblings.length));
  const before = i > 0 ? siblings[i - 1].rank : null;
  const after = i < siblings.length ? siblings[i].rank : null;
  return rankBetween(before, after);
}

export interface RankPlacement<T> {
  // The key to persist on the entity being placed.
  rank: string;
  // Siblings that must take a new key for the slot to exist, IN THE ORDER TO
  // WRITE THEM — before the placed entity. Empty unless the slot falls between
  // two tied keys.
  shifted: { item: T; rank: string }[];
}

// `rankForIndex` for ANY slot — the one a reorder/move calls. Same arguments,
// same clamping, and for a slot between two different keys (or at an open end)
// the same single key with nothing else rewritten.
//
// The difference is a slot between two TIED keys. A tie is an ordinary state,
// not a corruption (the header): two devices creating at the head of the same
// group mint the same key, and so does a backup merged into a library whose keys
// came from the same starting point. The sort breaks it by id, so the rows have
// a stable order on screen and a slot between them is a perfectly reasonable
// thing to ask for — but no key is strictly between two equal ones, and
// `rankBetween` throws on the pair. "Move up" on the row under a tied pair
// surfaced the library's bare " >= " as the error.
//
// So the tie is split: the tied siblings on ONE side of the slot are re-keyed
// along with the placed entity, into the gap between the tied key and its
// neighbour on that side. The shorter side moves (the trailing one when they are
// even), the other keeps its key. That is more than one write, which the model
// otherwise avoids — but only for the rows that were tied, and it leaves them
// untied.
//
// `shifted` is ordered so that each write, taken alone, leaves the siblings in
// the order they were already in: a caller that writes one transaction at a time
// writes `shifted` first and the placed entity last, and the only reorder a live
// read ever paints is the move that was asked for.
export function placeAtIndex<T extends { rank: string }>(
  siblings: T[],
  index: number,
): RankPlacement<T> {
  const i = Math.max(0, Math.min(index, siblings.length));
  const before = i > 0 ? siblings[i - 1].rank : null;
  const after = i < siblings.length ? siblings[i].rank : null;
  if (before === null || before !== after) {
    return { rank: rankBetween(before, after), shifted: [] };
  }

  // The run of tied keys around the slot: [start, i) before it, [i, end) after.
  const tied = before;
  let start = i - 1;
  while (start > 0 && siblings[start - 1].rank === tied) start--;
  let end = i + 1;
  while (end < siblings.length && siblings[end].rank === tied) end++;

  if (i - start < end - i) {
    // The leading side drops below the tied key, the placed entity last of them.
    // Ascending, so each one written is still ahead of those not yet written.
    const floor = start > 0 ? siblings[start - 1].rank : null;
    const keys = ranksBetween(floor, tied, i - start + 1);
    return {
      rank: keys[i - start],
      shifted: siblings.slice(start, i).map((item, n) => ({ item, rank: keys[n] })),
    };
  }

  // The trailing side rises above the tied key, the placed entity first of them.
  // Descending, for the same reason mirrored.
  const ceiling = end < siblings.length ? siblings[end].rank : null;
  const keys = ranksBetween(tied, ceiling, end - i + 1);
  return {
    rank: keys[0],
    shifted: siblings
      .slice(i, end)
      .map((item, n) => ({ item, rank: keys[n + 1] }))
      .reverse(),
  };
}

// Re-rank a sibling group into a NEW desired order (`ordered`), minting fresh
// keys for only the entities that must move. A bulk reorder (e.g. "sort A→Z")
// expressed as the same one-field `{ rank }` writes a single move makes, so it
// stays LWW-safe and an already-ordered group costs zero writes.
//
// Returns one entry per `ordered` item, positionally: a new rank string for an
// entity that must be re-ranked, or `null` to keep its current key. Items whose
// existing ranks are already ascending in the desired order are kept as anchors;
// each run of out-of-order items between two anchors gets evenly-spaced keys
// minted strictly between them (open-ended at the head/tail), so the whole group
// ends strictly ascending while the fewest files change.
//
// "Fewest" is the LONGEST ascending subsequence, not the first one found. The
// anchors used to be picked greedily from the head — keep each item that
// out-ranks the last kept — and that is minimal only when the stray sits BELOW
// where it belongs: one row dragged from the bottom of a group to the top became
// the leading anchor, out-ranked everything after it, and so re-ranked every
// other row in the group. That is n − 1 file writes for a one-row move — the
// exact renumbering the header says a fractional key exists to avoid — and since
// the callers write them one transaction at a time, the live read repainted the
// table once per write, through n − 2 orders nobody asked for.
export function rerankToOrder(ordered: { rank: string }[]): (string | null)[] {
  const result: (string | null)[] = new Array<string | null>(ordered.length).fill(null);

  const kept = longestAscending(ordered.map((item) => item.rank));

  // Fill each maximal run of non-anchors with keys between its bounding anchors.
  let i = 0;
  while (i < ordered.length) {
    if (kept[i]) {
      i++;
      continue;
    }
    const before = i > 0 ? ordered[i - 1].rank : null;

    let j = i;
    while (j < ordered.length && !kept[j]) j++;

    const after = j < ordered.length ? ordered[j].rank : null;
    const keys = ranksBetween(before, after, j - i);
    for (let k = i; k < j; k++) result[k] = keys[k - i];
    i = j;
  }

  return result;
}

// Which entries belong to one longest STRICTLY ascending subsequence — strict
// because two equal keys are a tie the sort breaks by id, not an order, so only
// one of a tied pair can anchor. Patience sorting: `tails[n]` is the index of the
// smallest rank that ends an ascending run of length n + 1, and `previous` links
// each entry to the one before it in its run, so the longest is read back from
// the last tail.
function longestAscending(ranks: string[]): boolean[] {
  const tails: number[] = [];
  const previous: number[] = [];

  for (let i = 0; i < ranks.length; i++) {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (ranks[tails[mid]] < ranks[i]) low = mid + 1;
      else high = mid;
    }
    previous[i] = low > 0 ? tails[low - 1] : -1;
    tails[low] = i;
  }

  const kept = ranks.map(() => false);
  for (let i = tails.length > 0 ? tails[tails.length - 1] : -1; i !== -1; i = previous[i]) {
    kept[i] = true;
  }
  return kept;
}
