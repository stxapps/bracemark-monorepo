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
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  let failed = false;
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined && !failed; item = queue.shift()) {
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  });
  await Promise.all(workers);
}
