// Split `arr` into contiguous sub-arrays of at most `size` — a pure array
// partition (no dep, no async). The workspace's batchers reach for this to keep
// a single statement's fan-out bounded: the sync engines slice a large
// put/commit/sign list into request-sized batches (web/expo `engine.ts`), and
// expo's item-store slices `IN (...)`/multi-row-insert lists under SQLite's
// bound-variable ceiling. Distinct from `mapLimit` (async/pool.ts), which caps
// in-flight concurrency but never groups — the two compose (chunk a list, pool
// each batch), so they sit together in `shared` rather than being re-spelled per
// caller.
//
// Lives in `shared` (platform-agnostic — only Array, no web/worker/expo APIs) so
// bracemark-web/bracemark-extension and bracemark-expo partition the same way.
//
// `size` must be a positive integer, and a bad one is REFUSED rather than
// absorbed, because each way of being bad failed silently and differently: 0 or
// a negative never advances the cursor (an unbounded loop allocating until the
// tab or app dies), NaN ran the body once and returned a single EMPTY batch
// (dropping every element while looking like it worked), and a fraction emitted
// batches LARGER than `size` — `chunk([a, b, c, d], 1.5)` gave
// `[[a], [b, c], [d]]`, which is exactly the bound-variable overflow the SQLite
// callers use this to prevent. Every call site today passes a literal, so this
// only fires on a newly derived size.
export function chunk<T>(arr: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk: size must be a positive integer, got ${size}`);
  }

  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
