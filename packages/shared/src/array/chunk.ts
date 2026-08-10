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
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
