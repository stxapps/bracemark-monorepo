// The export ⇄ import round trip, driven end to end through the two
// orchestrators and a REAL zip container.
//
// Why this file exists at all. `@stxapps/shared` covers both halves of the
// format separately and well — the serializers (export/), the parsers (import/),
// the archive contract (data/backup.ts) — but nothing anywhere holds the two
// halves against each other. `serializeBackupItems` and `classifyBundleLine` are
// tested with hand-written strings that agree by construction; the thing a user
// depends on is that the bytes THIS APP WRITES are the bytes THIS APP READS, with
// Dexie, zip.js and the write edge in between. A backup that exports cleanly and
// restores 90% of a library breaks nothing in the suite and everything for the
// person restoring it.
//
// The seam that makes it runnable headlessly: `exportAllData` claims its
// destination through `window.showSaveFilePicker` before the long phases (the
// transient-activation rule, see export-all-data.ts), and zip.js writes into
// whatever `createWritable()` hands back — so a plain `WritableStream` collecting
// chunks IS the Chromium stream branch, and the archive lands in memory as the
// real thing. zip.js needs no configuration here: `Worker` is absent under the
// node test environment, so it takes its no-worker path, and node supplies the
// `CompressionStream` it deflates with. The interop formats end at an anchor
// click instead, so those need the two DOM globals stubbed below and nothing
// more.
//
// NOT asserted here, on purpose: zip BYTES. Nothing promises those are stable —
// zip.js and expo's fflate produce different containers for the same library, and
// so does the same library exported twice (timestamps). What round-trips is the
// ENTITY SET, which is what data/backup.ts actually defines. The cross-platform
// half of that claim — a web-written archive read by expo, and the reverse —
// cannot be reached from either package (the module boundary forbids it) and
// lives in the golden fixtures both sides' specs read — see
// packages/shared/src/data/__fixtures__ and its keeper spec beside them,
// backup-fixtures.spec.ts.

// Type-only, so zip.js itself stays lazily imported here exactly as it is in the
// source under test.
import type { FileEntry } from '@zip.js/zip.js/index-native.js';

import {
  ARCHIVE_ID,
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  type ExportFormat,
  EXTRACTIONS_PREFIX,
  filesListEndpoint,
  filesSignEndpoint,
  LINKS_PREFIX,
  LISTS_PREFIX,
  MY_LIST_ID,
  opsCommitEndpoint,
  opsListEndpoint,
  PINS_PREFIX,
  ranksBetween,
  SETTINGS_GENERAL_PATH,
  syncPathSchema,
  TAGS_PREFIX,
  TRASH_ID,
  utf8,
} from '@stxapps/shared';
import {
  type BackupFixtureArchive,
  readBackupFixture,
  readBackupFixtureContents,
} from '@stxapps/shared/testing';

import type { SyncDeps } from '../sync/engine';
import { db } from './db';
import { exportAllData } from './export-all-data';
import { importAllData } from './import-all-data';
import { toItemRecord } from './projection';

const USER = 'alice';
// The device's sync cursor, and the top of the op-log window the stub reports.
const CURSOR = 1000;

// --- the api stub -------------------------------------------------------------
//
// The pre-export/pre-import sync refresh is best-effort and its failure is a
// user-visible warning (`syncFailed`), so it can't just be left to throw — that
// would put every case in this file on the warning path.
//
// It cannot be answered with a BLANK op log either, and the way that fails is
// worth writing down: `newestUpdatedAt: null` means "empty/wiped log under a
// returning client", which sends the cycle down the FALLBACK path (engine.ts
// `needsFallback`), whose whole job is to delete local records the server no
// longer lists. Every seeded entity is local-and-not-queued, so a blank reply
// wipes the library before the export reads it — and the export then succeeds,
// reporting zero of everything. The quietest TRUE answer is a log window that
// contains the cursor and carries no ops: the server agrees with this device.
//
// Nothing else here needs the network. `loadEntityContents` (the export's `files`
// phase) fetches only paths whose record has no `data`, and every blob these
// specs seed has bytes — so a signed URL is never asked for. A file path with no
// record at all is the missing-ref case, which it counts without a fetch.
function deps(): SyncDeps {
  return {
    username: USER,
    encryptionKey: {} as CryptoKey,
    api: {
      call: async (endpoint: unknown) => {
        if (endpoint === opsListEndpoint) {
          return { ops: [], oldestUpdatedAt: 500, newestUpdatedAt: CURSOR, hasMore: false };
        }
        if (endpoint === filesListEndpoint) return { files: [], nextPageToken: null };
        if (endpoint === filesSignEndpoint) return { urls: [] };
        if (endpoint === opsCommitEndpoint) return { results: [], failed: [] };
        throw new Error('unexpected endpoint');
      },
    } as unknown as SyncDeps['api'],
  };
}

// --- the save seams -----------------------------------------------------------

// The bytes the last bracemark export streamed, assembled in write order.
let zipChunks: Uint8Array[];
// Every blob an interop export handed to the anchor. A list rather than a single
// slot: the write happens inside the `createObjectURL` stub's closure, which the
// checker cannot see, so a variable reset to `undefined` before the export stays
// narrowed to `undefined` afterwards.
const downloads: Blob[] = [];

function savedZip(): File {
  const total = zipChunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of zipChunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new File([bytes], 'Bracemark backup.zip', { type: 'application/zip' });
}

// `showSaveFilePicker` is the Chromium branch and the one worth driving: it is
// the path a real export takes, and it yields the archive without a Blob round
// trip. The picker is installed per test rather than once, so the cancel case can
// replace it.
function installSavePicker(): void {
  (globalThis as { window?: unknown }).window = {
    showSaveFilePicker: async () => ({
      createWritable: async () =>
        new WritableStream<Uint8Array>({
          write(chunk) {
            zipChunks.push(chunk);
          },
        }),
    }),
  };
}

// The interop formats end at `downloadBlob` — an anchor click. Stubbed rather
// than run under jsdom because this package's specs need `structuredClone` for
// fake-indexeddb, which jsdom does not provide (jest.config.js says so at
// length). The stub captures the blob the user would have received.
function installAnchorDownload(): void {
  (globalThis as { document?: unknown }).document = {
    createElement: () => ({
      href: '',
      download: '',
      click: () => undefined,
      remove: () => undefined,
    }),
    body: { appendChild: () => undefined },
  };
  URL.createObjectURL = ((blob: Blob) => {
    downloads.push(blob);
    return 'blob:test';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
}

async function exportedText(format: Exclude<ExportFormat, 'bracemark'>): Promise<string> {
  downloads.length = 0;
  // `downloadBlob` defers its revoke by a minute, which outlives the test and keeps
  // the jest worker from exiting ("failed to exit gracefully"). Cancel every timer
  // the export left pending — the revoke is stubbed anyway, and clearing a timer that
  // already fired is a no-op.
  const timeout = jest.spyOn(globalThis, 'setTimeout');
  try {
    await exportAllData({ format, deps: deps(), excludedListIds: new Set() });
  } finally {
    for (const { value } of timeout.mock.results) clearTimeout(value);
    timeout.mockRestore();
  }
  if (downloads.length !== 1) throw new Error(`expected one download, got ${downloads.length}`);
  return await downloads[0].text();
}

// --- the library under test -----------------------------------------------------

const RANKS = ranksBetween(null, null, 6);
const T = 1_700_000_000_000;

interface Seeded {
  path: string;
  data: object;
}

// One entity per namespace, plus the three links the policy cases need: one in a
// user list, one in Trash, one in a list the lock provider covers. Written as raw
// `{path, data}` pairs because that is exactly what the archive carries — the
// same shape data/backup.ts defines.
function library(): Seeded[] {
  return [
    {
      path: `${LISTS_PREFIX}work.enc`,
      data: {
        id: 'work',
        name: 'Work',
        parentId: null,
        rank: RANKS[0],
        createdAt: T,
        updatedAt: T,
      },
    },
    {
      path: `${LISTS_PREFIX}specs.enc`,
      data: {
        id: 'specs',
        name: 'Specs',
        parentId: 'work',
        rank: RANKS[1],
        createdAt: T,
        updatedAt: T,
      },
    },
    {
      path: `${LISTS_PREFIX}secret.enc`,
      data: {
        id: 'secret',
        name: 'Diary',
        parentId: null,
        rank: RANKS[2],
        createdAt: T,
        updatedAt: T,
      },
    },
    {
      path: `${TAGS_PREFIX}read.enc`,
      data: {
        id: 'read',
        name: 'reading',
        parentId: null,
        rank: RANKS[3],
        createdAt: T,
        updatedAt: T,
      },
    },
    {
      path: `${LINKS_PREFIX}l_work.enc`,
      data: {
        url: 'https://work.invalid/spec',
        listId: 'specs',
        tagIds: ['read'],
        customTitle: 'The spec',
        createdAt: T + 3,
        updatedAt: T + 3,
      },
    },
    {
      path: `${LINKS_PREFIX}l_trash.enc`,
      data: {
        url: 'https://trash.invalid/gone',
        listId: TRASH_ID,
        tagIds: [],
        createdAt: T + 2,
        updatedAt: T + 2,
      },
    },
    {
      path: `${LINKS_PREFIX}l_secret.enc`,
      data: {
        url: 'https://diary.invalid/entry',
        listId: 'secret',
        tagIds: [],
        createdAt: T + 1,
        updatedAt: T + 1,
      },
    },
    {
      path: `${EXTRACTIONS_PREFIX}l_work.enc`,
      data: { id: 'l_work', facets: {}, imageId: 'img_work', createdAt: T, updatedAt: T },
    },
    {
      path: `${EXTRACTIONS_PREFIX}l_secret.enc`,
      data: { id: 'l_secret', facets: {}, imageId: 'img_secret', createdAt: T, updatedAt: T },
    },
    {
      path: `${PINS_PREFIX}l_work.enc`,
      data: { id: 'l_work', rank: RANKS[4], createdAt: T, updatedAt: T },
    },
    {
      path: `${PINS_PREFIX}l_secret.enc`,
      data: { id: 'l_secret', rank: RANKS[5], createdAt: T, updatedAt: T },
    },
    { path: SETTINGS_GENERAL_PATH, data: { linksLayout: 'list', createdAt: T, updatedAt: T } },
  ];
}

const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const SECRET_IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);

async function seed(entries: Seeded[] = library()): Promise<void> {
  for (const { path, data } of entries) {
    await db.items.put(toItemRecord(path, 5000, utf8(JSON.stringify(data))));
  }
  // The two referenced blobs, present locally so the `files` phase needs no
  // network. `files/` records hold raw bytes, not JSON.
  await db.items.put(toItemRecord('files/img_work.enc', 5000, IMAGE_BYTES));
  await db.items.put(toItemRecord('files/img_secret.enc', 5000, SECRET_IMAGE_BYTES));
}

// The store as `{path: json}`, which is the unit the round trip actually
// preserves — the record's own `updatedAt` is the SERVER's stamp for that path,
// not the entity's, so a restore starting from 0 is correct and comparing it
// would assert the opposite of the design.
async function storedEntities(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const record of await db.items.toArray()) {
    if (record.data === undefined) continue;
    out[record.path] = record.path.startsWith('files/')
      ? [...record.data]
      : JSON.parse(new TextDecoder().decode(record.data));
  }
  return out;
}

async function zipEntryNames(file: File): Promise<string[]> {
  const { BlobReader, ZipReader } = await import('@zip.js/zip.js/index-native.js');
  const reader = new ZipReader(new BlobReader(file));
  try {
    return (await reader.getEntries()).map((entry) => entry.filename);
  } finally {
    await reader.close();
  }
}

async function zipEntryText(file: File, name: string): Promise<string> {
  const { BlobReader, TextWriter, ZipReader } = await import('@zip.js/zip.js/index-native.js');
  const reader = new ZipReader(new BlobReader(file));
  try {
    const entry = (await reader.getEntries()).find(
      (candidate): candidate is FileEntry => !candidate.directory && candidate.filename === name,
    );
    if (entry === undefined) throw new Error(`no entry ${name}`);
    return await entry.getData(new TextWriter());
  } finally {
    await reader.close();
  }
}

beforeEach(async () => {
  zipChunks = [];
  downloads.length = 0;
  installSavePicker();
  installAnchorDownload();
  await db.items.clear();
  await db.pendingOps.clear();
  await db.syncMeta.clear();
  // Past the first-sync gate, so the refresh is an ordinary incremental cycle.
  await db.syncMeta.put({
    username: USER,
    syncCursorUpdatedAt: CURSOR,
    syncCursorPath: `${LINKS_PREFIX}l_seed.enc`,
    firstSyncDoneAt: 1,
  });
});

// --- the round trip ---------------------------------------------------------------

describe('the bracemark backup round trip', () => {
  it.each([0, 1])('recovers a restore interrupted after %i files', async (completedFiles) => {
    await seed();
    const before = await storedEntities();
    await exportAllData({ format: 'bracemark', deps: deps(), excludedListIds: new Set() });
    const file = savedZip();
    await db.items.clear();
    await db.pendingOps.clear();
    await expect(
      importAllData({
        file,
        deps: deps(),
        maxLinks: null,
        onProgress: (progress) => {
          if (progress.step === 'files' && progress.done === completedFiles)
            throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('interrupted');
    expect(
      Object.keys(await storedEntities()).filter((path) => path.startsWith(LINKS_PREFIX)),
    ).toEqual([]);
    const retry = await importAllData({ file, deps: deps(), maxLinks: null });
    expect(retry.linkCount).toBe(3);
    expect(retry.fileCount).toBe(2 - completedFiles);
    expect(await storedEntities()).toEqual(before);
  });

  it('rechecks skip-existing inside the write after a restore yields', async () => {
    await seed();
    await exportAllData({ format: 'bracemark', deps: deps(), excludedListIds: new Set() });
    const file = savedZip();
    await db.items.clear();
    await db.pendingOps.clear();
    const path = `${LINKS_PREFIX}l_work.enc`;
    const edited = {
      url: 'https://work.invalid/newer',
      listId: 'my-list',
      tagIds: [],
      customTitle: 'Arrived during restore',
      createdAt: T,
      updatedAt: T + 100,
    };
    let concurrent: Promise<unknown> | undefined;
    const outcome = await importAllData({
      file,
      deps: deps(),
      maxLinks: null,
      onProgress: (progress) => {
        if (progress.step === 'items' && progress.done === 0) {
          concurrent = db.items.put(toItemRecord(path, 6000, utf8(JSON.stringify(edited))));
        }
      },
    });
    await concurrent;
    expect((await storedEntities())[path]).toEqual(edited);
    expect(outcome.linkCount).toBe(2);
    expect(outcome.skippedCount).toBe(1);
  });
  // THE property of the format, and the one nothing else in the workspace can
  // hold: every namespace, its paths, its timestamps and its blob bytes come back
  // identical after a real zip has been written and read. A drop on either side —
  // a namespace the writer forgets, a line shape the reader classifies away —
  // is invisible until someone restores.
  it('restores every namespace verbatim into an empty library', async () => {
    await seed();
    const before = await storedEntities();

    const outcome = await exportAllData({
      format: 'bracemark',
      deps: deps(),
      excludedListIds: new Set(),
    });
    expect(outcome.linkCount).toBe(3);
    expect(outcome.fileCount).toBe(2);
    expect(outcome.missingFileCount).toBe(0);
    expect(outcome.syncFailed).toBe(false);

    await db.items.clear();
    await db.pendingOps.clear();

    const restored = await importAllData({ file: savedZip(), deps: deps(), maxLinks: null });
    expect(restored.linkCount).toBe(3);
    expect(restored.listCount).toBe(3);
    expect(restored.tagCount).toBe(1);
    expect(restored.fileCount).toBe(2);
    expect(restored.invalidCount).toBe(0);
    expect(restored.skippedCount).toBe(0);

    expect(await storedEntities()).toEqual(before);
  });

  // The write edge is the whole reason a mid-restore crash loses nothing: an
  // import is ordinary local edits, so the durable queue carries it to the server
  // exactly like a typed one. A restore that wrote items straight past the queue
  // would look perfect on this device and never reach any other.
  it('lands the restore as queued local edits, not as silent writes', async () => {
    await seed();
    await exportAllData({ format: 'bracemark', deps: deps(), excludedListIds: new Set() });
    await db.items.clear();
    await db.pendingOps.clear();

    await importAllData({ file: savedZip(), deps: deps(), maxLinks: null });

    const queued = (await db.pendingOps.where('username').equals(USER).toArray()).map(
      (o) => o.path,
    );
    expect(queued).toEqual(
      expect.arrayContaining([`${LINKS_PREFIX}l_work.enc`, 'files/img_work.enc']),
    );
    expect(queued.length).toBe(Object.keys(await storedEntities()).length);
  });

  // A file ref is an id the ARCHIVE supplies, and a restore turns it into a
  // `files/` path and a queued put. One the wire contract cannot carry is refused
  // by the request contract before it leaves the device, every cycle, and the
  // push it rides in takes the metadata puts and the pull behind it down as well
  // — with nothing in the app that removes a single queued op. The gate is
  // classifyBundleLine's, covered field by field in shared data/backup.spec.ts.
  // What only this file can hold is that nothing reaches the store or the queue
  // AROUND it: the archive below really carries the blob under the bad id, so an
  // importer that wrote blobs from refs it never classified is caught here.
  it('refuses a line whose file ref cannot be a sync path, and queues nothing for it', async () => {
    // A filename for an id — what an archive written by something that isn't this
    // app would plausibly carry. No first-party writer mints one (ids are UUIDs).
    const badId = 'cover.png';
    const badLink = `${LINKS_PREFIX}l_bad.enc`;
    await seed([
      ...library(),
      {
        path: badLink,
        data: {
          url: 'https://bad.invalid/',
          listId: 'work',
          tagIds: [],
          customImageId: badId,
          createdAt: T + 4,
          updatedAt: T + 4,
        },
      },
    ]);
    await db.items.put(toItemRecord(`files/${badId}.enc`, 5000, IMAGE_BYTES));
    await exportAllData({ format: 'bracemark', deps: deps(), excludedListIds: new Set() });
    expect(await zipEntryNames(savedZip())).toContain(`files/${badId}`);
    await db.items.clear();
    await db.pendingOps.clear();

    const outcome = await importAllData({ file: savedZip(), deps: deps(), maxLinks: null });

    // Reported, and not fatal: the three good links still land.
    expect(outcome.invalidCount).toBe(1);
    expect(outcome.linkCount).toBe(3);
    expect(outcome.fileCount).toBe(2);
    const stored = Object.keys(await storedEntities());
    expect(stored).not.toContain(badLink);
    expect(stored).not.toContain(`files/${badId}.enc`);

    const queued = (await db.pendingOps.where('username').equals(USER).toArray()).map(
      (o) => o.path,
    );
    for (const path of queued) expect(syncPathSchema.safeParse(path).success).toBe(true);
    // …and the queue is not simply empty.
    expect(queued).toContain('files/img_work.enc');
  });

  // Skip-existing by path. The failure it prevents is the loud one: a restore run
  // on a device that has kept editing, silently rolling those edits back to the
  // archive's copy. The positive half is in the same case — an entity the local
  // store does NOT have is still written, so "skips everything" fails too.
  it('never clobbers a path the local store already holds', async () => {
    await seed();
    await exportAllData({ format: 'bracemark', deps: deps(), excludedListIds: new Set() });

    // The device kept working after the backup: one link retitled, one deleted.
    const edited = {
      url: 'https://work.invalid/spec',
      listId: 'specs',
      tagIds: ['read'],
      customTitle: 'The spec, revised',
      createdAt: T + 3,
      updatedAt: T + 9,
    };
    await db.items.put(
      toItemRecord(`${LINKS_PREFIX}l_work.enc`, 6000, utf8(JSON.stringify(edited))),
    );
    await db.items.delete(`${LINKS_PREFIX}l_trash.enc`);

    const outcome = await importAllData({ file: savedZip(), deps: deps(), maxLinks: null });

    const after = await storedEntities();
    expect(after[`${LINKS_PREFIX}l_work.enc`]).toEqual(edited);
    expect(after[`${LINKS_PREFIX}l_trash.enc`]).toEqual(
      library().find((e) => e.path === `${LINKS_PREFIX}l_trash.enc`)?.data,
    );
    expect(outcome.linkCount).toBe(1);
    expect(outcome.skippedCount).toBeGreaterThan(0);
  });

  // Trash is IN the backup and out of every interop file, and the two halves have
  // to be asserted together — a backup that drops Trash is not a backup, and an
  // interop file that carries it re-adds deleted bookmarks to the user's browser.
  //
  // Worth knowing before you mutate this one: the interop half is guarded TWICE
  // in export-all-data.ts — `interopLinks` filters Trash out, and
  // `buildInteropBundle` skips it again while filling the folders. Deleting
  // either alone leaves this green, which reads as a worthless assertion and
  // isn't; delete both.
  it('carries Trash, which no interop format does', async () => {
    await seed();
    await exportAllData({ format: 'bracemark', deps: deps(), excludedListIds: new Set() });
    const items = await zipEntryText(savedZip(), BACKUP_ITEMS_ENTRY);
    expect(items).toContain('https://trash.invalid/gone');

    for (const format of ['netscape', 'csv', 'text'] as const) {
      const text = await exportedText(format);
      expect(text).not.toContain('https://trash.invalid/gone');
      // The positive control: the same run does carry the live link, so "contains
      // nothing" cannot pass these three.
      expect(text).toContain('https://work.invalid/spec');
    }
  });

  // A locked list leaves as a whole: its links, their satellites, their blobs AND
  // the list entity itself — a hidden list's NAME is as sensitive as its contents.
  // Every assertion here is a negative, so the unlocked link, its pin, its
  // extraction and its blob are asserted present in the same run.
  it('excludes a locked list entirely — entities, satellites, blobs and the name', async () => {
    await seed();
    const outcome = await exportAllData({
      format: 'bracemark',
      deps: deps(),
      excludedListIds: new Set(['secret']),
    });
    expect(outcome.linkCount).toBe(2);
    expect(outcome.fileCount).toBe(1);

    const file = savedZip();
    const items = await zipEntryText(file, BACKUP_ITEMS_ENTRY);
    expect(items).not.toContain('https://diary.invalid/entry');
    expect(items).not.toContain('Diary');
    expect(items).not.toContain(`${PINS_PREFIX}l_secret.enc`);
    expect(items).not.toContain(`${EXTRACTIONS_PREFIX}l_secret.enc`);
    expect(await zipEntryNames(file)).not.toContain('files/img_secret');

    expect(items).toContain('https://work.invalid/spec');
    expect(items).toContain(`${PINS_PREFIX}l_work.enc`);
    expect(items).toContain(`${EXTRACTIONS_PREFIX}l_work.enc`);
    expect(await zipEntryNames(file)).toContain('files/img_work');
  });

  // A blob the archive references but cannot include (deleted server-side, never
  // known locally) is counted and shipped anyway. The alternative — failing the
  // export — would make one dangling ref cost the user their whole backup.
  it('reports a dangling blob ref instead of failing the export', async () => {
    await seed();
    await db.items.delete('files/img_work.enc');

    const outcome = await exportAllData({
      format: 'bracemark',
      deps: deps(),
      excludedListIds: new Set(),
    });
    expect(outcome.missingFileCount).toBe(1);
    expect(outcome.fileCount).toBe(1);
    expect(await zipEntryNames(savedZip())).toContain(BACKUP_MANIFEST_ENTRY);
  });

  // The manifest is the archive's identity, and the reader branches on it: a zip
  // WITHOUT it is an interop zip, not a corrupt backup. Pinned here rather than in
  // shared because it is the orchestrator's dispatch, not the parser's.
  it('writes a manifest whose counts describe what actually shipped', async () => {
    await seed();
    await exportAllData({
      format: 'bracemark',
      deps: deps(),
      excludedListIds: new Set(['secret']),
    });
    const manifest = JSON.parse(await zipEntryText(savedZip(), BACKUP_MANIFEST_ENTRY));
    expect(manifest.counts).toEqual({
      links: 2,
      lists: 2,
      tags: 1,
      pins: 1,
      extractions: 1,
      files: 1,
    });
  });
});

// --- interop is a migration, not a round trip ---------------------------------------

describe('the interop formats', () => {
  // The property that IS true of interop, and the one users hit: re-importing a
  // file you exported adds nothing, because dedupe is by canonical URL identity.
  // A regression here doubles someone's library on a second click.
  it('re-import adds nothing, because the URLs are already there', async () => {
    await seed();
    const html = await exportedText('netscape');
    const before = await storedEntities();

    const outcome = await importAllData({
      file: new File([html], 'bookmarks.html', { type: 'text/html' }),
      deps: deps(),
      maxLinks: null,
    });

    expect(outcome.linkCount).toBe(0);
    expect(outcome.skippedCount).toBe(2);
    expect(await storedEntities()).toEqual(before);
  });

  // Into an EMPTY library the same file rebuilds the folder tree at position, not
  // as flat root lists — the find-or-create walk's contract, driven here through
  // real serialize→parse rather than a hand-written fixture, so a folder the
  // serializer nests one way and the parser reads another shows up.
  it('rebuilds the nested folder tree on the far end', async () => {
    await seed();
    const html = await exportedText('netscape');
    await db.items.clear();
    await db.pendingOps.clear();

    const outcome = await importAllData({
      file: new File([html], 'bookmarks.html', { type: 'text/html' }),
      deps: deps(),
      maxLinks: null,
    });
    expect(outcome.linkCount).toBe(2);

    const lists = Object.entries(await storedEntities())
      .filter(([path]) => path.startsWith(LISTS_PREFIX))
      .map(([, data]) => data as { id: string; name: string; parentId: string | null });
    const work = lists.find((list) => list.name === 'Work');
    const specs = lists.find((list) => list.name === 'Specs');
    expect(work).toBeDefined();
    expect(specs?.parentId).toBe(work?.id);
    // System lists are merged on read, never minted as user lists by an import.
    expect(lists.map((list) => list.id)).not.toContain(MY_LIST_ID);
    expect(lists.map((list) => list.id)).not.toContain(ARCHIVE_ID);
  });

  // A file-carried title lands as the link's OWN title, `customTitle`, where the
  // extractor can fill in under it but never replace it: an interop file can't
  // say whether the user renamed a link, and overwriting a rename is the one
  // unrecoverable outcome (@stxapps/shared import/bundle.ts, ImportedLink). The
  // import writes no extraction, so every link is still pending for the
  // extractor — and a title that only restates the address (what our export
  // writes for an untitled link) is no title at all.
  it("lands a file-carried title as the link's own, above extraction", async () => {
    await seed();
    const html = await exportedText('netscape');
    await db.items.clear();
    await db.pendingOps.clear();
    await importAllData({
      file: new File([html], 'bookmarks.html', { type: 'text/html' }),
      deps: deps(),
      maxLinks: null,
    });

    const stored = await storedEntities();
    const links = Object.entries(stored)
      .filter(([path]) => path.startsWith(LINKS_PREFIX))
      .map(([, data]) => data as { url: string; customTitle?: string });
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) {
      expect(link.customTitle).toBe(
        link.url === 'https://work.invalid/spec' ? 'The spec' : undefined,
      );
    }
    expect(Object.keys(stored).filter((path) => path.startsWith(EXTRACTIONS_PREFIX))).toEqual([]);
  });
});

// --- the cross-platform half --------------------------------------------------------

describe('the golden archives', () => {
  // The claim neither package can make alone: web reads what EXPO wrote. The two
  // platforms use different zip libraries by necessity (zip.js is not portable to
  // Hermes), so "the layout is one definition" is a promise about two containers,
  // and @nx/enforce-module-boundaries means no single spec can hold both sides.
  // The fixtures are the seam — generated by
  // tools/scripts/generate-backup-fixtures.ts, kept honest by
  // packages/shared/src/data/backup-fixtures.spec.ts, and read here and by
  // expo-react's sibling spec.
  // Addressed through the package rather than by counting directories up to
  // `packages/`: nothing checks a path spelled as a string, so a `shared` that
  // moved would fail here as a missing file rather than as a boundary error.
  const contents = readBackupFixtureContents();

  const load = (name: BackupFixtureArchive): File =>
    new File([readBackupFixture(name)], name, { type: 'application/zip' });

  // Both, and not just the foreign one: the zip.js archive is the regression
  // guard for this app's own container across a zip.js upgrade, which is the
  // other way a backup made last year stops restoring.
  it.each<BackupFixtureArchive>(['backup-expo.zip', 'backup-web.zip'])(
    'restores %s into this platform, entities and blob bytes intact',
    async (name) => {
      const outcome = await importAllData({ file: load(name), deps: deps(), maxLinks: null });
      expect(outcome.invalidCount).toBe(0);
      expect(outcome.skippedCount).toBe(0);

      const stored = await storedEntities();
      for (const { path, data } of contents.entities) {
        expect(stored[path]).toEqual(data);
      }
      for (const { id, bytes } of contents.files) {
        expect(stored[`files/${id}.enc`]).toEqual(bytes);
      }
    },
  );
});
