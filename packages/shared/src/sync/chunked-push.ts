import { chunk } from '../array/chunk';

// One put set's sign → PUT → commit, as a single fan-out across its chunks. Both
// engines' pushPuts (web-react and expo-react sync/engine.ts) run on it;
// docs/local-first-sync.md, _a push is chunked_, has the rules and _measuring a
// sync_ the reading behind them.
//
// What it replaced was a loop of sign → upload → commit, one chunk at a time.
// Each chunk's upload ended in a drain, the fan-out narrowing to its slowest PUT
// (p95 ~2 s against a p50 of ~1.1 s on staging), and each next chunk waited a
// whole `files/sign` round trip before its first PUT. A 10,000-link push kept 63
// of 96 PUTs in flight and spent 51 s in signs that nothing ran beside. Here a
// chunk is signed while the one before is still moving, and its PUTs start as
// the earlier chunk's free their slots — the pull's shape (pull-fan-out.ts),
// with the commit that a pull does not have.
//
// What a chunk still is, and what each rule keeps:
//
//  - ONE SIGN AND ONE COMMIT. A chunk fits both caps in one call each, and spends
//    one call of each of the api's `tight` rate-limit buckets.
//  - COMMITS IN ORDER, ONE IN FLIGHT. A chunk commits once its own uploads have
//    settled AND the chunk before it has committed, so the op log takes the set
//    in input order, and a failed commit stops the set: no chunk commits after it
//    and no PUT starts after it.
//  - SIGNED AHEAD, BOUNDED TWICE. The next chunk is signed once fewer than `lead`
//    of the signed ops are still unsettled — the fan-out is about to run short —
//    and only once the chunk two before it has committed. The first bound keeps a
//    PUT's mint-to-PUT latency to its own chunk's window plus the tail of the one
//    before; the caller sizes it per blob kind, small for the kind that can be
//    slow enough to outlive a PUT token. The second keeps what the quota gate
//    cannot see at a sign to the one chunk it could not see before, and the
//    pending count at most one chunk behind the signs.
//
// FAILURE. A refused sign (`null`, the quota gate) stops the signing: the chunks
// already signed upload and commit, and the result counts the refused chunk and
// every one after it, none of them asked. Any other sign failure stops the
// signing the same way, and is thrown once the signed chunks have committed — the
// progress is kept. A throw from `upload` (which must catch what it means to
// tolerate per op) or from `commit` stops everything: nothing more starts, what is
// in flight settles, and the run rejects with it. The run never settles while a
// sign, a PUT or a commit it started is still running, so a failed cycle never
// lets the next one read a queue a commit is still clearing.

export interface PushedChunk<Op, V> {
  // The chunk's place in the set.
  index: number;
  ops: readonly Op[];
  // What `upload` returned for each op, aligned with `ops`.
  results: readonly V[];
  // `now()` at the chunk's sign, its first PUT's start and its last PUT's end —
  // for the caller's timing spans.
  signStart: number;
  uploadStart: number;
  uploadEnd: number;
}

export interface ChunkedPushOptions<Op extends { path: string }, S, V> {
  ops: readonly Op[];
  chunkSize: number;
  concurrency: number;
  // Sign the next chunk once fewer than this many signed ops are unsettled.
  // Default: two rounds of the fan-out.
  lead?: number;
  // One chunk's signed values by path, or `null` when the quota gate refused it.
  sign: (ops: readonly Op[]) => Promise<ReadonlyMap<string, S> | null>;
  // One op's transfer. `signed` is undefined for a path the sign did not answer.
  upload: (op: Op, signed: S | undefined) => Promise<V>;
  commit: (chunk: PushedChunk<Op, V>) => Promise<void>;
  now?: () => number;
}

export interface ChunkedPushResult {
  // Ops in a chunk the quota gate refused, or in any chunk after it.
  refused: number;
}

interface ChunkState<Op, V> {
  index: number;
  ops: readonly Op[];
  results: V[];
  unsettled: number;
  signStart: number;
  uploadStart: number | undefined;
  uploadEnd: number | undefined;
  uploaded: () => void;
  committed: Promise<void>;
}

interface Ready<Op, S, V> {
  chunk: ChunkState<Op, V>;
  at: number;
  signed: S | undefined;
}

export async function runChunkedPush<Op extends { path: string }, S, V>(
  options: ChunkedPushOptions<Op, S, V>,
): Promise<ChunkedPushResult> {
  const { ops, chunkSize, concurrency, sign, upload, commit } = options;
  const lead = options.lead ?? 2 * concurrency;
  const now = options.now ?? Date.now;
  for (const [name, value] of [
    ['chunkSize', chunkSize],
    ['concurrency', concurrency],
    ['lead', lead],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`runChunkedPush: ${name} must be a positive integer, got ${value}`);
    }
  }

  const chunks = chunk([...ops], chunkSize);
  const signed: ChunkState<Op, V>[] = [];
  const ready: Ready<Op, S, V>[] = [];
  // Signed ops not yet settled: queued in `ready` or in a PUT.
  let unsettled = 0;
  let refused = 0;
  // No more signs. Set by a refusal, a sign failure, or `stop`.
  let halted = false;
  // No more PUTs or commits start.
  let stopped = false;
  let signerDone = false;
  let failure: { error: unknown } | undefined;
  let commitLine: Promise<void> = Promise.resolve();

  let wakers: (() => void)[] = [];
  const wake = (): void => {
    const woken = wakers;
    wakers = [];
    for (const resolve of woken) resolve();
  };
  const changed = (): Promise<void> => new Promise((resolve) => wakers.push(resolve));

  const fail = (error: unknown): void => {
    failure ??= { error };
  };
  const stop = (error: unknown): void => {
    fail(error);
    stopped = true;
    halted = true;
    // A chunk whose PUTs will never all run would hold the commit line, and the
    // signer waiting on it, forever. Released, its commit sees `stopped` and
    // skips.
    for (const c of signed) c.uploaded();
    wake();
  };

  const signer = async (): Promise<void> => {
    try {
      for (let i = 0; i < chunks.length; i++) {
        while (!halted && i > 0 && unsettled >= lead) await changed();
        if (i >= 2) await signed[i - 2].committed.catch(() => undefined);
        if (halted) return;

        const ops = chunks[i];
        const signStart = now();
        let urls: ReadonlyMap<string, S> | null;
        try {
          urls = await sign(ops);
        } catch (error) {
          fail(error);
          halted = true;
          return;
        }
        if (stopped) return;
        if (urls === null) {
          for (let j = i; j < chunks.length; j++) refused += chunks[j].length;
          halted = true;
          return;
        }

        let uploaded!: () => void;
        const uploadsDone = new Promise<void>((resolve) => (uploaded = resolve));
        const state: ChunkState<Op, V> = {
          index: i,
          ops,
          results: new Array<V>(ops.length),
          unsettled: ops.length,
          signStart,
          uploadStart: undefined,
          uploadEnd: undefined,
          uploaded,
          committed: Promise.resolve(),
        };
        state.committed = commitLine = commitLine
          .then(() => uploadsDone)
          .then(async () => {
            if (stopped) return;
            const end = state.uploadEnd ?? now();
            try {
              await commit({
                index: state.index,
                ops: state.ops,
                results: state.results,
                signStart: state.signStart,
                uploadStart: state.uploadStart ?? end,
                uploadEnd: end,
              });
            } catch (error) {
              stop(error);
              throw error;
            }
          });
        // Observed, so a failure is never unhandled while later chunks move; the
        // line itself still carries the rejection to every later link.
        state.committed.catch(() => undefined);
        signed.push(state);

        unsettled += ops.length;
        for (let at = 0; at < ops.length; at++) {
          ready.push({ chunk: state, at, signed: urls.get(ops[at].path) });
        }
        wake();
      }
    } finally {
      signerDone = true;
      wake();
    }
  };

  const settle = (state: ChunkState<Op, V>): void => {
    unsettled -= 1;
    state.unsettled -= 1;
    if (state.unsettled === 0) {
      state.uploadEnd = now();
      state.uploaded();
    }
    wake();
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return;
      const next = ready.shift();
      if (next) {
        const { chunk: state, at, signed: value } = next;
        state.uploadStart ??= now();
        try {
          state.results[at] = await upload(state.ops[at], value);
        } catch (error) {
          stop(error);
        } finally {
          settle(state);
        }
        continue;
      }
      if (signerDone) return;
      await changed();
    }
  };

  await Promise.all([signer(), ...Array.from({ length: concurrency }, worker)]);
  await commitLine.catch(() => undefined);
  if (failure) throw failure.error;
  return { refused };
}
