// Local write-edge specs. The load-bearing property here is ATOMICITY: a write puts
// the record and enqueues its pending op in ONE transaction, so the local store and
// the durable queue can never disagree about whether an edit happened. Everything
// downstream leans on it — the sync engine treats a queued op as proof that bytes
// exist for it (engine.ts uploadOne), so a half-write would produce an op nothing
// can ever satisfy.
//
// The read-merge writers (writeExtraction, writeSettingsGeneral) get the rest of the
// attention: they validate INSIDE the transaction, which is only safe if a rejected
// entity takes its pending op down with it.
//
// The BULK writers (bulkWriteLinks, bulkDeleteEntities) owe the same property over N
// paths at once, plus one the single-path spelling gets for free: they re-read each
// current blob inside their own transaction, so a caller's stale row snapshot can't
// resurrect a field a sync overwrote. Every bulk action in both apps rides them, so a
// regression here is a whole selection's worth of edits, not one.

import {
  ARCHIVE_ID,
  DEFAULT_LIST_ID,
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  LINK_TITLE_MAX,
  LINKS_PREFIX,
  newFacet,
  pathFromId,
} from '@stxapps/shared';

import { db } from './db';
import {
  bulkDeleteEntities,
  bulkWriteLinks,
  writeExtraction,
  writeFile,
  writeLink,
} from './mutations';
import { type LinkItem, readExtraction, readLinkById } from './queries';
import { seedNewAccount } from './sync-store';

const USER = 'alice';
const LINK_ID = 'l_a';
const PATH = pathFromId(LINK_ID, EXTRACTIONS_PREFIX);

function pendingFor(path: string) {
  return db.pendingOps.get([USER, path]);
}

beforeEach(async () => {
  await db.items.clear();
  await db.pendingOps.clear();
  await db.syncMeta.clear();
  await seedNewAccount(USER);
});

it('refuses a late local write after another account owns the store', async () => {
  await db.syncMeta.clear();
  await seedNewAccount('bob');
  await expect(
    writeExtraction(USER, LINK_ID, { fields: { title: 'old account' } }),
  ).rejects.toThrow(/no longer signed in/);
  expect(await db.items.count()).toBe(0);
  expect(await db.pendingOps.count()).toBe(0);
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

  it('deletes the blob a re-capture replaced, and keeps the ones it did not', async () => {
    // A re-capture mints a new file id. Before this, the old blob stayed in `files/`
    // with nothing referencing it: the sweep and the destroy paths find blobs through
    // the extraction's CURRENT refs, so it counted against the quota for good.
    const bytes = new Uint8Array([1, 2, 3]);
    await writeFile(USER, 'shot-1', bytes);
    await writeFile(USER, 'read-1', bytes);
    await writeExtraction(USER, LINK_ID, {
      fields: { screenshotId: 'shot-1', readModeId: 'read-1' },
    });

    await writeFile(USER, 'shot-2', bytes);
    await writeExtraction(USER, LINK_ID, { fields: { screenshotId: 'shot-2' } });

    const shot1 = pathFromId('shot-1', FILES_PREFIX);
    expect(await db.items.get(shot1)).toBeUndefined();
    expect(await pendingFor(shot1)).toMatchObject({ op: 'delete' });
    expect(await db.items.get(pathFromId('shot-2', FILES_PREFIX))).toBeDefined();
    // A field the patch didn't touch keeps its blob.
    expect(await db.items.get(pathFromId('read-1', FILES_PREFIX))).toBeDefined();
  });

  it('deletes nothing when a write re-states the same ref', async () => {
    const bytes = new Uint8Array([1]);
    await writeFile(USER, 'img-1', bytes);
    await writeExtraction(USER, LINK_ID, { fields: { imageId: 'img-1' } });
    await writeExtraction(USER, LINK_ID, {
      fields: { imageId: 'img-1' },
      facet: 'titleImage',
      state: newFacet('done', 'extension:fg'),
    });

    expect(await db.items.get(pathFromId('img-1', FILES_PREFIX))).toBeDefined();
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

// --- the bulk writers --------------------------------------------------------

const LIST_A = DEFAULT_LIST_ID;

function linkPath(id: string): string {
  return pathFromId(id, LINKS_PREFIX);
}

// A stored link, written through the ordinary single-path writer so the batch is
// always compared against what the app actually has on disk.
async function seedLink(id: string, url: string, listId = LIST_A): Promise<LinkItem> {
  const link: LinkItem = {
    url,
    tagIds: [],
    listId,
    createdAt: 0,
    updatedAt: 0,
    path: linkPath(id),
  };
  await writeLink(USER, link, {});
  const stored = await readLinkById(id);
  if (!stored) throw new Error(`seedLink: ${id} was not written`);
  return stored;
}

describe('bulkWriteLinks', () => {
  it('writes every link and its pending op in one go', async () => {
    const a = await seedLink('l_b1', 'https://a.example');
    const b = await seedLink('l_b2', 'https://b.example');
    await db.pendingOps.clear(); // ignore the seeds' own ops

    await bulkWriteLinks(USER, [
      { link: a, patch: { listId: ARCHIVE_ID } },
      { link: b, patch: { listId: ARCHIVE_ID } },
    ]);

    expect((await readLinkById('l_b1'))?.listId).toBe(ARCHIVE_ID);
    expect((await readLinkById('l_b2'))?.listId).toBe(ARCHIVE_ID);
    expect(await pendingFor(linkPath('l_b1'))).toMatchObject({ op: 'put', baseUpdatedAt: 0 });
    expect(await pendingFor(linkPath('l_b2'))).toMatchObject({ op: 'put', baseUpdatedAt: 0 });
  });

  it('takes a per-link patch, not one patch for the batch', async () => {
    // What the retag dialog needs: "add these, remove those" resolves against each
    // link's own tagIds, so the two links below get different bytes from one call.
    const a = await seedLink('l_b3', 'https://a.example');
    const b = await seedLink('l_b4', 'https://b.example');

    await bulkWriteLinks(USER, [
      { link: a, patch: { tagIds: ['t_1'] } },
      { link: b, patch: { tagIds: ['t_1', 't_2'] } },
    ]);

    expect((await readLinkById('l_b3'))?.tagIds).toEqual(['t_1']);
    expect((await readLinkById('l_b4'))?.tagIds).toEqual(['t_1', 't_2']);
  });

  it("merges onto the CURRENT blob, not the caller's snapshot", async () => {
    // The staleness rule `update` spells out as a re-read before the write: a row
    // snapshot can be older than the store (a sync landed while the selection sat
    // in bulk-edit mode), and merging onto it would silently revert the field the
    // sync brought. Here the note arrives after the snapshot was taken.
    const stale = await seedLink('l_b5', 'https://a.example');
    await writeLink(USER, stale, { note: 'from another device' });

    await bulkWriteLinks(USER, [{ link: stale, patch: { listId: ARCHIVE_ID } }]);

    const link = await readLinkById('l_b5');
    expect(link?.listId).toBe(ARCHIVE_ID);
    expect(link?.note).toBe('from another device');
  });

  it('keeps createdAt and advances updatedAt, exactly like writeLink', async () => {
    const seeded = await seedLink('l_b6', 'https://a.example');

    await bulkWriteLinks(USER, [{ link: seeded, patch: { listId: ARCHIVE_ID } }]);

    const link = await readLinkById('l_b6');
    expect(link?.createdAt).toBe(seeded.createdAt);
    expect(link?.updatedAt).toBeGreaterThanOrEqual(seeded.updatedAt);
  });

  it('rolls the WHOLE batch back when one link fails validation', async () => {
    // The batch is one transaction, so a rejected link can't leave the others
    // half-written — nor an op for bytes that were never stored (the engine treats a
    // queued op as proof they exist).
    const a = await seedLink('l_b7', 'https://a.example');
    const b = await seedLink('l_b8', 'https://b.example');
    await db.pendingOps.clear();

    await expect(
      bulkWriteLinks(USER, [
        { link: a, patch: { listId: ARCHIVE_ID } },
        { link: b, patch: { customTitle: 'x'.repeat(LINK_TITLE_MAX + 1) } },
      ]),
    ).rejects.toThrow(/invalid link/);

    expect((await readLinkById('l_b7'))?.listId).toBe(LIST_A);
    expect(await pendingFor(linkPath('l_b7'))).toBeUndefined();
    expect(await pendingFor(linkPath('l_b8'))).toBeUndefined();
  });

  it('is a no-op for an empty batch', async () => {
    await bulkWriteLinks(USER, []);
    expect(await db.pendingOps.where('username').equals(USER).count()).toBe(0);
  });

  it("never lets a row snapshot's joined display fields into the blob", async () => {
    // The recreate path: the link was deleted on another device and that delete
    // synced, but the user still holds its row (a bulk selection, a staged
    // snapshot) and edits it — so the write falls back to the caller's object,
    // which is a `LinkView`. `linkSchema` is a `looseObject`, the projector
    // indexes none of these names and `toView` overwrites all four on read, so
    // nothing downstream would ever report them; they would just ride the blob to
    // every device. Stripped at the write edge instead (queries.ts `toItem`).
    const view = {
      url: 'https://a.example',
      tagIds: [],
      listId: LIST_A,
      createdAt: 1,
      updatedAt: 1,
      path: linkPath('l_b13'),
      title: 'from the extraction join',
      imageId: 'f_1',
      pageCopyId: 'f_2',
      screenshotId: 'f_3',
    };

    await bulkWriteLinks(USER, [{ link: view, patch: { listId: ARCHIVE_ID } }]);

    const stored = await readLinkById('l_b13');
    expect(stored?.listId).toBe(ARCHIVE_ID);
    expect(stored).not.toHaveProperty('title');
    expect(stored).not.toHaveProperty('imageId');
    expect(stored).not.toHaveProperty('pageCopyId');
    expect(stored).not.toHaveProperty('screenshotId');
  });

  it('preserves an unknown field a newer client wrote', async () => {
    // The other half of the rule above: `looseObject` keeps what it doesn't know,
    // and a batched edit must not be the thing that drops it.
    const path = linkPath('l_b14');
    const seeded = await seedLink('l_b14', 'https://a.example');
    const record = await db.items.get(path);
    if (!record?.data) throw new Error('seedLink: no bytes');
    const blob = { ...JSON.parse(new TextDecoder().decode(record.data)), futureField: 'keep me' };
    await db.items.put({ ...record, data: new TextEncoder().encode(JSON.stringify(blob)) });

    await bulkWriteLinks(USER, [{ link: seeded, patch: { listId: ARCHIVE_ID } }]);

    const stored = await readLinkById('l_b14');
    expect((stored as unknown as { futureField?: string }).futureField).toBe('keep me');
  });
});

describe('bulkDeleteEntities', () => {
  it('drops every path and queues one delete per path', async () => {
    await seedLink('l_b9', 'https://a.example');
    await seedLink('l_b10', 'https://b.example');

    await bulkDeleteEntities(USER, [linkPath('l_b9'), linkPath('l_b10')]);

    expect(await readLinkById('l_b9')).toBeUndefined();
    expect(await readLinkById('l_b10')).toBeUndefined();
    expect(await pendingFor(linkPath('l_b9'))).toMatchObject({ op: 'delete' });
    expect(await pendingFor(linkPath('l_b10'))).toMatchObject({ op: 'delete' });
  });

  it('queues the stored server stamp as the reconcile base', async () => {
    await seedLink('l_b11', 'https://a.example');
    // What a synced record looks like: the engine restamped `updatedAt` with R2's
    // time on commit. That value is the base the next reconcile diffs against.
    await db.items.update(linkPath('l_b11'), { updatedAt: 1_700_000_000_000 });

    await bulkDeleteEntities(USER, [linkPath('l_b11')]);

    expect(await pendingFor(linkPath('l_b11'))).toMatchObject({
      op: 'delete',
      baseUpdatedAt: 1_700_000_000_000,
    });
  });

  it('tombstones a path with no local record', async () => {
    // destroyMany sweeps a link's pin and extraction whether or not it ever had
    // either — locally a no-op, upstream a harmless tombstone.
    const absent = pathFromId('l_b12', EXTRACTIONS_PREFIX);

    await bulkDeleteEntities(USER, [absent]);

    expect(await pendingFor(absent)).toMatchObject({ op: 'delete', baseUpdatedAt: 0 });
  });

  it('is a no-op for an empty batch', async () => {
    await bulkDeleteEntities(USER, []);
    expect(await db.pendingOps.where('username').equals(USER).count()).toBe(0);
  });
});
