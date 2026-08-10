import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { userDataStub } from './user-data';

// The Durable Object is the other thing a Node runner can't test: its schema is
// migrated IN CODE on construction, its op log keysets off a real (updated_at,
// path) cursor, and the quota map is real SQLite. Here the DO is a real
// SQLite-backed instance, so these assertions actually prove the migration ran,
// the cursor semantics hold, and the quota map tracks. RPC methods are awaited
// across the stub.
//
// commitOps is now a pure batched write against the DO's own SQLite — the R2 HEAD
// (put existence check + R2's LastModified/size, and dropping puts with no object)
// lives in services/sync.ts, which passes only the survivors in. So these tests
// hand commitOps explicit (updatedAt, size) entries and assert they round-trip;
// the R2-first handshake is covered end-to-end in routes/sync.spec.ts.
describe('UserDataDO op log', () => {
  it('commits ops and reads them back over the (updatedAt, path) cursor', async () => {
    const stub = userDataStub(env, 'user-a');

    const { results } = await stub.commitOps([
      { op: 'put', path: 'links/a.enc', updatedAt: 1000, size: 3 },
      { op: 'put', path: 'links/b.enc', updatedAt: 2000, size: 5 },
      { op: 'delete', path: 'links/a.enc', updatedAt: 3000, size: 0 },
    ]);

    // commitOps returns each recorded updatedAt (input order) the client advances
    // its cursor to.
    expect(results.map((r) => r.updatedAt)).toEqual([1000, 2000, 3000]);

    // A full pull from the start (null cursor) returns every op, ordered by
    // (updatedAt, path).
    const { ops, oldestUpdatedAt, newestUpdatedAt, hasMore } = await stub.listOps(null, null, 500);
    expect(hasMore).toBe(false);
    expect(ops.map((o) => o.path).sort()).toEqual(['links/a.enc', 'links/a.enc', 'links/b.enc']);
    expect(oldestUpdatedAt).toBe(1000);
    expect(newestUpdatedAt).toBe(3000);

    // The quota map tracks live objects only: a.enc was deleted, so just b.enc's
    // 5 bytes remain.
    const usage = await stub.usage();
    expect(usage.fileCount).toBe(1);
    expect(usage.totalBytes).toBe(5);
  });

  it('pages with the keyset cursor and reports hasMore', async () => {
    const stub = userDataStub(env, 'user-page');
    let ts = 1000;
    for (const id of ['a', 'b', 'c']) {
      await stub.commitOps([{ op: 'put', path: `links/${id}.enc`, updatedAt: ts, size: 1 }]);
      ts += 1000;
    }

    // limit 2 over 3 ops ⇒ first page is full and hasMore is true.
    const first = await stub.listOps(null, null, 2);
    expect(first.ops).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    // Resume from the last op's (updatedAt, path) ⇒ the remaining op, no more.
    const last = first.ops[first.ops.length - 1];
    const second = await stub.listOps(last.updatedAt, last.path, 2);
    expect(second.ops).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  // The clamp: a put's timestamp is minted at PUT time (R2's LastModified) but only
  // becomes visible at commit time, so a slow committer can arrive carrying a stamp
  // older than ops already in the log — behind cursors other clients have already
  // advanced past, where a keyset pull would never see it. commitOps must lift such
  // an entry above everything recorded, and return the lifted stamp (it is what the
  // committing client stores locally and advances its own cursor to).
  it('clamps a commit that arrives with a stamp behind the log', async () => {
    const stub = userDataStub(env, 'user-clamp');
    await stub.commitOps([{ op: 'put', path: 'links/fast.enc', updatedAt: 5000, size: 1 }]);

    // The slow committer: its blob was PUT at t=1000, but its commit lands after
    // fast.enc's. Recorded — and returned — as newest + 1, never 1000.
    const { results } = await stub.commitOps([
      { op: 'put', path: 'links/slow.enc', updatedAt: 1000, size: 1 },
    ]);
    expect(results).toEqual([{ path: 'links/slow.enc', updatedAt: 5001 }]);

    // A cursor at the pre-commit newest now finds the late op instead of skipping it.
    const pulled = await stub.listOps(5000, 'links/fast.enc', 500);
    expect(pulled.ops).toEqual([{ op: 'put', path: 'links/slow.enc', updatedAt: 5001 }]);

    // An in-order commit is untouched — the clamp only engages on the race.
    const inOrder = await stub.commitOps([
      { op: 'put', path: 'links/next.enc', updatedAt: 9000, size: 1 },
    ]);
    expect(inOrder.results[0].updatedAt).toBe(9000);
  });

  it('reports null bounds for a never-written log', async () => {
    const empty = await userDataStub(env, 'user-empty').listOps(null, null, 500);
    expect(empty).toEqual({
      ops: [],
      oldestUpdatedAt: null,
      newestUpdatedAt: null,
      hasMore: false,
    });
  });

  // usage() is what the put gate reads (lib/quota.ts), and it must track the
  // durable size map rather than the op log: a delete frees its recorded bytes
  // even though the op that deleted it is still in the log.
  it('reports usage off the size map, freeing deleted paths', async () => {
    const stub = userDataStub(env, 'user-usage');
    await stub.commitOps([
      { op: 'put', path: 'links/kept.enc', updatedAt: 1000, size: 300 },
      { op: 'put', path: 'links/gone.enc', updatedAt: 2000, size: 700 },
    ]);
    expect(await stub.usage()).toEqual({ fileCount: 2, totalBytes: 1000 });

    await stub.commitOps([{ op: 'delete', path: 'links/gone.enc', updatedAt: 3000, size: 0 }]);
    expect(await stub.usage()).toEqual({ fileCount: 1, totalBytes: 300 });
  });

  it('counts a re-put once, at its newest size', async () => {
    // The map is keyed by path (UPSERT), so an in-place update replaces the
    // recorded size instead of adding a second entry. This is what keeps the
    // byte total honest without the gate needing to know it was an update.
    const stub = userDataStub(env, 'user-reput');
    await stub.commitOps([{ op: 'put', path: 'links/a.enc', updatedAt: 1000, size: 100 }]);
    await stub.commitOps([{ op: 'put', path: 'links/a.enc', updatedAt: 2000, size: 250 }]);
    expect(await stub.usage()).toEqual({ fileCount: 1, totalBytes: 250 });
  });

  it('reports zero usage for a never-written user', async () => {
    expect(await userDataStub(env, 'user-no-usage').usage()).toEqual({
      fileCount: 0,
      totalBytes: 0,
    });
  });

  it('isolates each user log in its own DO instance', async () => {
    // Distinct userIds map to distinct DO instances (idFromName), so logs don't
    // bleed across users — the per-user isolation the DO model buys us.
    await userDataStub(env, 'user-b').commitOps([
      { op: 'put', path: 'links/only.enc', updatedAt: 1000, size: 1 },
    ]);

    const otherUser = await userDataStub(env, 'user-c').listOps(null, null, 500);
    expect(otherUser.ops).toHaveLength(0);
  });
});
