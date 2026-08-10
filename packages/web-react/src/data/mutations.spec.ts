// Local write-edge specs. The load-bearing property here is ATOMICITY: a write puts
// the record and enqueues its pending op in ONE transaction, so the local store and
// the durable queue can never disagree about whether an edit happened. Everything
// downstream leans on it — the sync engine treats a queued op as proof that bytes
// exist for it (engine.ts uploadBlobs), so a half-write would produce an op nothing
// can ever satisfy.
//
// The read-merge writers (writeExtraction, writeSettingsGeneral) get the rest of the
// attention: they validate INSIDE the transaction, which is only safe if a rejected
// entity takes its pending op down with it.

import { EXTRACTIONS_PREFIX, LINK_TITLE_MAX, newFacet, pathFromId } from '@stxapps/shared';

import { db } from './db';
import { writeExtraction } from './mutations';
import { readExtraction } from './queries';

const USER = 'alice';
const LINK_ID = 'l_a';
const PATH = pathFromId(LINK_ID, EXTRACTIONS_PREFIX);

function pendingFor(path: string) {
  return db.pendingOps.get([USER, path]);
}

beforeEach(async () => {
  await db.items.clear();
  await db.pendingOps.clear();
});

describe('writeExtraction', () => {
  it('writes the record and its pending op together', async () => {
    await writeExtraction(USER, LINK_ID, { fields: { title: 'Google' } });

    expect((await readExtraction(LINK_ID))?.title).toBe('Google');
    expect(await pendingFor(PATH)).toMatchObject({ op: 'put', baseUpdatedAt: 0 });
  });

  it('rolls the pending op back when the merged entity fails validation', async () => {
    // The first suspicion in the bug report this suite was written for: an extraction
    // rejected by its schema leaving a pending op behind. It cannot — the validation
    // throws inside the transaction, so neither store keeps anything. (The real cause
    // was downstream, in the engine; see engine.spec.ts.)
    await expect(
      writeExtraction(USER, LINK_ID, { fields: { title: 'x'.repeat(LINK_TITLE_MAX + 1) } }),
    ).rejects.toThrow(/invalid extraction/);

    expect(await db.items.get(PATH)).toBeUndefined();
    expect(await pendingFor(PATH)).toBeUndefined();
  });

  it('leaves a prior record untouched when a later write is rejected', async () => {
    await writeExtraction(USER, LINK_ID, { fields: { title: 'Google' } });

    await expect(
      writeExtraction(USER, LINK_ID, { fields: { title: 'x'.repeat(LINK_TITLE_MAX + 1) } }),
    ).rejects.toThrow(/invalid extraction/);

    expect((await readExtraction(LINK_ID))?.title).toBe('Google');
  });

  it('merges a facet onto an existing record without dropping its fields', async () => {
    // The extension's two-pass titleImage capture: the title lands fields-only, then
    // the terminal write adds the facet. Pass 2 must not erase pass 1.
    await writeExtraction(USER, LINK_ID, { fields: { title: 'Google' } });
    await writeExtraction(USER, LINK_ID, {
      facet: 'titleImage',
      state: newFacet('done', 'extension:fg'),
    });

    const extraction = await readExtraction(LINK_ID);
    expect(extraction?.title).toBe('Google');
    expect(extraction?.facets.titleImage?.status).toBe('done');
  });

  it('counts retries across writes, ignoring the caller-supplied placeholder', async () => {
    // `attempts` is the WRITER's to own — only the read-merge sees the prior value —
    // so repeated failures have to escalate even though newFacet always passes 0.
    for (let i = 0; i < 3; i++) {
      await writeExtraction(USER, LINK_ID, {
        facet: 'titleImage',
        state: newFacet('failed', 'extension:fg'),
      });
    }
    expect((await readExtraction(LINK_ID))?.facets.titleImage?.attempts).toBe(3);

    // A success settles it back to zero.
    await writeExtraction(USER, LINK_ID, {
      facet: 'titleImage',
      state: newFacet('done', 'extension:fg'),
    });
    expect((await readExtraction(LINK_ID))?.facets.titleImage?.attempts).toBe(0);
  });

  it('is read back fresh when two writes land in the same millisecond', async () => {
    // The read layer memoizes decodes keyed by (updatedAt, itemUpdatedAt). A local
    // write freezes the first at its sync base and stamps the second with Date.now(),
    // so two writes to one path inside a millisecond are INDISTINGUISHABLE to that
    // key and the first one's decode would be served for the second's bytes. Not
    // exotic: this is the extension's titleImage capture on a page with no preview
    // image — the title write and the terminal facet write, back to back with only a
    // transaction between them (docs/link-extraction.md).
    //
    // `Date.now` alone, not jest's fake timers: those also replace setImmediate /
    // queueMicrotask, which fake-indexeddb schedules its request callbacks on, so the
    // whole suite deadlocks. Freezing the clock is the point anyway — the bug is a
    // same-millisecond coincidence, and racing the real clock made this flaky (~1 run
    // in 30) instead of failing honestly.
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      await writeExtraction(USER, LINK_ID, { fields: { title: 'Google' } });
      expect((await readExtraction(LINK_ID))?.title).toBe('Google'); // populate the memo
      await writeExtraction(USER, LINK_ID, {
        facet: 'titleImage',
        state: newFacet('done', 'extension:fg'),
      });

      expect((await readExtraction(LINK_ID))?.facets.titleImage?.status).toBe('done');
    } finally {
      now.mockRestore();
    }
  });

  it('keeps one queue row per path across repeated edits', async () => {
    await writeExtraction(USER, LINK_ID, { fields: { title: 'first' } });
    await writeExtraction(USER, LINK_ID, { fields: { title: 'second' } });

    expect(await db.pendingOps.where('username').equals(USER).count()).toBe(1);
  });

  it('projects each facet status for the index', async () => {
    await writeExtraction(USER, LINK_ID, {
      facet: 'titleImage',
      state: newFacet('done', 'extension:fg'),
    });
    await writeExtraction(USER, LINK_ID, {
      facet: 'screenshot',
      state: newFacet('permanent', 'extension:fg'),
    });

    // The projection is written in the same put as the bytes it describes, so the
    // multiEntry index can never drift from the blob.
    expect((await db.items.get(PATH))?.itemFacetStatuses?.sort()).toEqual([
      'done:titleImage',
      'permanent:screenshot',
    ]);
  });
});
