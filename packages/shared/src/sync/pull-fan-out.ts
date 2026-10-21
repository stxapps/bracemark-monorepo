// One pull's transfers as a single fan-out: entries go in as they become known —
// all at once from a cycle, a page at a time from a first sync's listing — and
// `concurrency` workers move them, each with the URL `files/sign` minted for it.
// Both engines' storeDownloads (web-react and expo-react sync/engine.ts) run on
// it; docs/local-first-sync.md, _measuring a sync_, has the reading behind it.
//
// What it replaced was a loop of sign → mapLimit → sign → mapLimit, one batch
// at a time. Each batch ended in a drain, the fan-out narrowing to its slowest
// transfer, and each next batch waited a whole `files/sign` round trip before
// its first GET. Here a batch is signed while the one before is still moving,
// and the fan-out stays full across the seam. Nothing waits for the listing
// either: a first sync's GETs start on its first page.
//
// SIGNED ONE BATCH AHEAD, NEVER MORE. The next batch is asked for once the
// signed queue is down to its last two rounds, and only one sign is in flight,
// so what is held is about one batch of URLs — the bound the batch loop had, for
// the reason it had it: a GET token is good for an hour, and a large library
// listed whole and signed up front would outlive its own URLs before the last of
// them was fetched.
//
// FAILURE: the first rejection — from `run` or from `sign` — stops the feed.
// No entry starts after it; the ones in flight settle; `close` rejects with it,
// and neither `close` nor `abandon` settles before they have.
// That is mapLimit's policy (async/pool.ts), and the engines keep the same
// per-entry tolerance on top of it: `run` catches what it means to skip.

export interface PullFanOut<E> {
  // Queue more entries. Starts their signing if the fan-out is short of work;
  // never waits on the network itself. Throws the failure once there is one, so
  // a feed still listing stops instead of queueing work nothing will run.
  add(entries: readonly E[]): void;
  // No more entries are coming. Resolves once every queued entry has run, or
  // rejects with the first failure once the transfers in flight have settled.
  close(): Promise<void>;
  // Stop feeding work, for a failure outside the fan-out (the listing that was
  // adding to it threw). Resolves once the transfers in flight have settled, so
  // a caller that awaits it never returns while one is still storing: a first
  // sync that rejected with its GETs still running let its retry pull beside
  // them, and a straggler could land an older version over the retry's newer
  // one, under a cursor that then claimed both. Never rejects.
  abandon(reason: unknown): Promise<void>;
}

export interface PullFanOutOptions<E, S> {
  concurrency: number;
  // Paths per `sign` call — the contract's cap.
  signBatch: number;
  sign: (paths: string[]) => Promise<Map<string, S>>;
  // One entry's transfer. `signed` is undefined for a path the sign call did
  // not answer, which the engines skip.
  run: (entry: E, signed: S | undefined) => Promise<void>;
}

export function createPullFanOut<E extends { path: string }, S>(
  options: PullFanOutOptions<E, S>,
): PullFanOut<E> {
  const { concurrency, signBatch, sign, run } = options;
  for (const [name, value] of [
    ['concurrency', concurrency],
    ['signBatch', signBatch],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`createPullFanOut: ${name} must be a positive integer, got ${value}`);
    }
  }

  const unsigned: E[] = [];
  const ready: { entry: E; signed: S | undefined }[] = [];
  let signing = false;
  let closed = false;
  let failure: { error: unknown } | undefined;
  let wakers: (() => void)[] = [];

  const wake = (): void => {
    const woken = wakers;
    wakers = [];
    for (const resolve of woken) resolve();
  };
  const changed = (): Promise<void> => new Promise((resolve) => wakers.push(resolve));
  const fail = (error: unknown): void => {
    failure ??= { error };
    wake();
  };

  const refill = (): void => {
    if (signing || failure || unsigned.length === 0 || ready.length >= 2 * concurrency) return;
    signing = true;
    const batch = unsigned.splice(0, signBatch);
    void sign(batch.map((e) => e.path))
      .then((urls) => {
        for (const entry of batch) ready.push({ entry, signed: urls.get(entry.path) });
      }, fail)
      .finally(() => {
        signing = false;
        refill();
        wake();
      });
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (failure) return;
      refill();
      const next = ready.shift();
      if (next) {
        try {
          await run(next.entry, next.signed);
        } catch (error) {
          fail(error);
          return;
        }
        continue;
      }
      if (closed && unsigned.length === 0 && !signing) return;
      await changed();
    }
  };
  // Never rejects: a worker's failure is recorded, and `close` reports it.
  const workers = Array.from({ length: concurrency }, worker);

  return {
    add(entries) {
      if (closed) throw new Error('createPullFanOut: add after close');
      if (failure) throw failure.error;
      // A loop, not push(...entries): a spread past the engine's argument limit
      // throws, and a listing can be any size.
      for (const entry of entries) unsigned.push(entry);
      refill();
      wake();
    },
    async close() {
      closed = true;
      wake();
      await Promise.all(workers);
      if (failure) throw failure.error;
    },
    async abandon(reason) {
      fail(reason);
      await Promise.all(workers);
    },
  };
}
