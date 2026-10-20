// Specs for a put set's pipeline (chunked-push.ts): PUTs that cross chunk
// boundaries, a sign ahead bounded by `lead` and by the commit two chunks back,
// commits in order, and the failure policy. Driven by deferreds rather than
// timers, as signed-fan-out.spec.ts is: the interleavings are what is under test.

import { type PushedChunk, runChunkedPush } from './chunked-push';

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res));
};

interface Op {
  path: string;
}

const ops = (n: number): Op[] =>
  Array.from({ length: n }, (_, i) => ({ path: `links/l_${i}.enc` }));

// A sign that answers every path with its own name, and records each call.
function recordingSign() {
  const calls: string[][] = [];
  const sign = async (chunk: readonly Op[]) => {
    calls.push(chunk.map((o) => o.path));
    return new Map(chunk.map((o) => [o.path, `url:${o.path}`]));
  };
  return { calls, sign };
}

// An upload held until the case releases it, path by path.
function heldUploads() {
  const gates = new Map<string, Deferred>();
  const started: string[] = [];
  const upload = async (op: Op, signed: string | undefined) => {
    started.push(op.path);
    const gate = deferred();
    gates.set(op.path, gate);
    await gate.promise;
    return signed;
  };
  const release = async (...paths: string[]) => {
    for (const p of paths) gates.get(p)?.resolve();
    await flush();
  };
  const releaseAll = async () => {
    for (;;) {
      const open = [...gates.keys()].filter((p) => started.includes(p));
      for (const p of open) gates.get(p)?.resolve();
      await flush();
      if ([...gates.keys()].length === open.length) return;
    }
  };
  return { started, upload, release, releaseAll };
}

describe('runChunkedPush', () => {
  it('uploads every op with its own signed value and commits each chunk in order', async () => {
    const { calls, sign } = recordingSign();
    const commits: PushedChunk<Op, string | undefined>[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await runChunkedPush({
      ops: ops(10),
      chunkSize: 4,
      concurrency: 3,
      sign,
      upload: async (_op, signed) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await flush();
        inFlight -= 1;
        return signed;
      },
      commit: async (chunk) => {
        commits.push(chunk);
      },
    });

    expect(result).toEqual({ refused: 0 });
    expect(calls.map((c) => c.length)).toEqual([4, 4, 2]);
    expect(commits.map((c) => c.index)).toEqual([0, 1, 2]);
    for (const c of commits) {
      expect(c.results).toEqual(c.ops.map((o) => `url:${o.path}`));
    }
    expect(maxInFlight).toBe(3);
  });

  it('starts the next chunk’s PUTs while the last chunk’s slowest PUT is still running', async () => {
    // The seam this replaced: a chunk's upload narrowed to its slowest PUT before
    // the next chunk could sign, and the fan-out idled behind it.
    const { sign } = recordingSign();
    const held = heldUploads();
    const all = ops(8);
    const run = runChunkedPush({
      ops: all,
      chunkSize: 4,
      concurrency: 2,
      sign,
      upload: held.upload,
      commit: async () => undefined,
    });

    await flush();
    await held.release(all[0].path, all[1].path);
    expect(held.started).toEqual(all.slice(0, 4).map((o) => o.path));
    await held.release(all[2].path);
    // all[3] — the first chunk's last PUT — is still running, and the second
    // chunk's first PUT has the slot all[2] freed.
    expect(held.started).toContain(all[4].path);

    await held.releaseAll();
    await run;
  });

  it('signs ahead once fewer than `lead` signed ops are unsettled, and never two at once', async () => {
    const { calls, sign } = recordingSign();
    const held = heldUploads();
    const all = ops(12);
    const run = runChunkedPush({
      ops: all,
      chunkSize: 4,
      concurrency: 2,
      lead: 2,
      sign,
      upload: held.upload,
      commit: async () => undefined,
    });

    await flush();
    expect(calls).toHaveLength(1);
    await held.release(all[0].path, all[1].path);
    // Two of four settled, two unsettled: not yet below the lead.
    expect(calls).toHaveLength(1);
    await held.release(all[2].path);
    // One unsettled: the next chunk is signed, and only that one.
    expect(calls).toHaveLength(2);

    await held.releaseAll();
    await run;
    expect(calls).toHaveLength(3);
  });

  it('signs a chunk only once the chunk two before it has committed', async () => {
    // What keeps the quota gate's blind spot at one chunk, and the pending count
    // at most one chunk behind the signs.
    const { calls, sign } = recordingSign();
    const firstCommit = deferred();
    const committed: number[] = [];
    const run = runChunkedPush({
      ops: ops(6),
      chunkSize: 2,
      concurrency: 4,
      sign,
      upload: async () => undefined,
      commit: async (chunk) => {
        if (chunk.index === 0) await firstCommit.promise;
        committed.push(chunk.index);
      },
    });

    await flush();
    // Chunks 0 and 1 are signed and uploaded; chunk 2 waits on chunk 0's commit.
    expect(calls).toHaveLength(2);
    expect(committed).toEqual([]);

    firstCommit.resolve();
    await run;
    expect(calls).toHaveLength(3);
    expect(committed).toEqual([0, 1, 2]);
  });

  it('commits in input order even when a later chunk finishes uploading first', async () => {
    const { sign } = recordingSign();
    const held = heldUploads();
    const all = ops(4);
    const order: number[] = [];
    let committing = 0;
    let maxCommitting = 0;
    const run = runChunkedPush({
      ops: all,
      chunkSize: 2,
      concurrency: 4,
      sign,
      upload: held.upload,
      commit: async (chunk) => {
        committing += 1;
        maxCommitting = Math.max(maxCommitting, committing);
        await flush();
        order.push(chunk.index);
        committing -= 1;
      },
    });

    await flush();
    await held.release(all[2].path, all[3].path);
    expect(order).toEqual([]);

    await held.releaseAll();
    await run;
    expect(order).toEqual([0, 1]);
    expect(maxCommitting).toBe(1);
  });

  it('commits the chunks signed before a refusal, and counts the rest unasked', async () => {
    let signs = 0;
    const committed: number[] = [];
    const result = await runChunkedPush({
      ops: ops(10),
      chunkSize: 3,
      concurrency: 2,
      sign: async (chunk) => {
        signs += 1;
        if (signs === 2) return null;
        return new Map(chunk.map((o) => [o.path, 'url']));
      },
      upload: async () => undefined,
      commit: async (chunk) => {
        committed.push(chunk.index);
      },
    });

    expect(signs).toBe(2);
    expect(committed).toEqual([0]);
    expect(result.refused).toBe(7);
  });

  it('commits what it signed before a failed sign, then rejects with it', async () => {
    const boom = new Error('sign failed');
    let signs = 0;
    const committed: number[] = [];
    await expect(
      runChunkedPush({
        ops: ops(6),
        chunkSize: 2,
        concurrency: 2,
        sign: async (chunk) => {
          signs += 1;
          if (signs === 2) throw boom;
          return new Map(chunk.map((o) => [o.path, 'url']));
        },
        upload: async () => undefined,
        commit: async (chunk) => {
          committed.push(chunk.index);
        },
      }),
    ).rejects.toBe(boom);

    expect(signs).toBe(2);
    expect(committed).toEqual([0]);
  });

  it('stops at a failed commit: no later commit, no later PUT, and settles what is in flight first', async () => {
    const { sign } = recordingSign();
    const held = heldUploads();
    const all = ops(6);
    const boom = new Error('commit failed');
    const committed: number[] = [];
    let settled = false;
    const run = runChunkedPush({
      ops: all,
      chunkSize: 2,
      concurrency: 1,
      lead: 3,
      sign,
      upload: held.upload,
      commit: async (chunk) => {
        committed.push(chunk.index);
        throw boom;
      },
    }).finally(() => (settled = true));
    const outcome = expect(run).rejects.toBe(boom);

    await flush();
    await held.release(all[0].path);
    await held.release(all[1].path);
    // Chunk 0's commit failed while chunk 1's first PUT was running.
    expect(committed).toEqual([0]);
    expect(held.started).toEqual([all[0].path, all[1].path, all[2].path]);
    expect(settled).toBe(false);

    await held.release(all[2].path);
    await outcome;
    expect(committed).toEqual([0]);
    expect(held.started).toHaveLength(3);
  });

  it('stops on an upload that throws, and rejects with it', async () => {
    const { sign } = recordingSign();
    const boom = new Error('store gone');
    const uploaded: string[] = [];
    const commit = jest.fn(async () => undefined);
    await expect(
      runChunkedPush({
        ops: ops(5),
        chunkSize: 5,
        concurrency: 1,
        sign,
        upload: async (op) => {
          uploaded.push(op.path);
          if (uploaded.length === 2) throw boom;
        },
        commit,
      }),
    ).rejects.toBe(boom);

    expect(uploaded).toHaveLength(2);
    expect(commit).not.toHaveBeenCalled();
  });

  it('passes undefined for a path the sign did not answer', async () => {
    const seen: (string | undefined)[] = [];
    await runChunkedPush({
      ops: ops(3),
      chunkSize: 3,
      concurrency: 2,
      sign: async (chunk) => new Map(chunk.slice(1).map((o) => [o.path, 'url'])),
      upload: async (_op, signed: string | undefined) => {
        seen.push(signed);
      },
      commit: async () => undefined,
    });

    expect(seen.filter((s) => s === undefined)).toHaveLength(1);
  });

  it('signs and commits nothing for an empty set', async () => {
    const sign = jest.fn(async () => new Map<string, string>());
    const commit = jest.fn(async () => undefined);

    await expect(
      runChunkedPush({ ops: [], chunkSize: 2, concurrency: 2, sign, upload: jest.fn(), commit }),
    ).resolves.toEqual({ refused: 0 });
    expect(sign).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ['chunkSize', { chunkSize: 0, concurrency: 1 }],
    ['concurrency', { chunkSize: 1, concurrency: 0 }],
    ['lead', { chunkSize: 1, concurrency: 1, lead: 0 }],
  ])('refuses a %s that is not a positive integer', async (_name, sizes) => {
    await expect(
      runChunkedPush({
        ops: ops(1),
        ...sizes,
        sign: async () => new Map(),
        upload: async () => undefined,
        commit: async () => undefined,
      }),
    ).rejects.toThrow(RangeError);
  });
});
