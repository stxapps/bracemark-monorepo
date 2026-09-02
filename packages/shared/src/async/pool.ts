// Run `fn` over `items` with at most `limit` in flight — a minimal concurrency pool
// (no dep) that bounds the work in flight without serializing everything: a large first
// sync's socket count, or an extraction batch's image-proxy fetches, stay capped.
//
// Failure policy: a rejection from `fn` fails the pool — the first error propagates,
// and the rest of the queue is ABANDONED (items already in flight run to completion;
// every worker's rejection is observed, so none goes unhandled). A caller that wants
// per-item tolerance instead catches inside `fn` and records the failure itself — the
// engines' upload/download loops and the extraction passes all do exactly that — so a
// throw reaching the pool always means "stop feeding work into a failing cycle".
//
// Lives in `shared` (platform-agnostic — only Promise/Array, no web/worker APIs) so every
// app pools the same way: bracemark-web/bracemark-extension's sync engine + server extraction
// today, and the future bracemark-expo, instead of each re-spelling the worker loop.
//
// `limit` must be a positive integer, and a bad one is REFUSED rather than
// absorbed: `Math.min(0, n)` spawns ZERO workers, so `mapLimit(items, 0, fn)`
// used to resolve cleanly having run nothing at all — a cycle that uploaded
// nothing and reported success, which is the same false 'idle' the failure
// policy above exists to prevent. Every call site passes a literal, so this only
// fires on a newly derived limit.
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`mapLimit: limit must be a positive integer, got ${limit}`);
  }

  // Snapshot the list and hand out INDEXES. The obvious spelling — workers
  // draining a shared queue with `shift()` until it yields `undefined` — cannot
  // tell an exhausted queue from a legitimately `undefined` item, so a single
  // `undefined` (or a sparse hole) halted every worker early and the pool still
  // resolved: partial work reported as a complete pass, silently. `next++` needs
  // no lock — there is no await between the read and the increment.
  const queue = [...items];
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (!failed) {
      const index = next++;
      if (index >= queue.length) return;
      try {
        await fn(queue[index]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
}
