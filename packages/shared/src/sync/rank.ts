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
// tie, never data loss — broken deterministically by id in the sort.

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
// clamped to `[0, siblings.length]`; 0 prepends, `length` appends. This is the
// one helper a reorder/move UI calls: it turns "drop at position i" into the key
// to persist on the moved entity — and nothing else is rewritten.
export function rankForIndex(siblings: { rank: string }[], index: number): string {
  const i = Math.max(0, Math.min(index, siblings.length));
  const before = i > 0 ? siblings[i - 1].rank : null;
  const after = i < siblings.length ? siblings[i].rank : null;
  return rankBetween(before, after);
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
