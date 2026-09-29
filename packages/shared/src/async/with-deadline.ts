// Run a network `work` under a deadline it cannot ignore: reject with
// `onTimeout(ms)` when the deadline passes, then abort the signal `work` was
// handed. The sibling of `withTimeout`, for work that can be CANCELLED: that one
// races a promise it doesn't own; this one owns the AbortSignal, so the losing
// request is torn down rather than left running.
//
// `fetch` has no deadline of its own. A server that accepts the connection and
// never answers — or a network that silently drops the packets — leaves it
// pending forever, and in the sync engine one pending request holds the
// single-flight cycle every later sync joins (docs/local-first-sync.md). Callers:
// the contract client (every bracemark-api and extractor call) and the R2 blob
// transfers (sync/r2.ts on both platforms).
//
// The deadline REJECTS; the abort only tidies. Settling must not depend on the
// work honoring its signal, because the whole point is a promise that always
// settles. The abort is sent after the rejection, to release the connection; the
// work's resulting AbortError is observed by Promise.race and dropped.
//
// `rearm(ms)` restarts the clock from now with a new duration, for work that can
// see its own progress — an R2 GET calls it on every chunk of the body, which
// turns the deadline into an idle one: it passes only when nothing arrives.
//
// A caller's `signal` is FORWARDED, not handed through: the work always gets this
// helper's own signal, which a caller's abort also aborts.
export async function withDeadline<T>(
  work: (signal: AbortSignal, rearm: (timeoutMs: number) => void) => Promise<T>,
  timeoutMs: number,
  onTimeout: (timeoutMs: number) => Error,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', forwardAbort);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let expire!: (ms: number) => void;
  const deadline = new Promise<never>((_, reject) => {
    expire = (ms) => {
      reject(onTimeout(ms));
      controller.abort();
    };
  });
  const arm = (ms: number) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => expire(ms), ms);
  };

  arm(timeoutMs);
  try {
    return await Promise.race([work(controller.signal, arm), deadline]);
  } finally {
    // Same reason as `withTimeout`: a winning call must not leave the timer armed
    // (an open handle in jest, a pinned closure in the app).
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
