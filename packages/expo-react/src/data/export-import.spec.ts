// The export ⇄ import round trip on expo — the ported half of web-react's
// data/export-import.spec.ts, written to the ported-pair rule (docs/testing.md):
// cover the protocol once, cover the DIVERGENCE always, plus a thin drift guard.
//
// Web's copy is canonical for the policy matrix (Trash in the backup and out of
// every interop file, the locked-list exclusion in all four of its dimensions,
// the interop dedupe). Repeating it here would prove nothing extra and break on
// every legitimate edit. What only this platform can lose:
//
//   - A DIFFERENT ZIP LIBRARY. fflate's zipSync/unzipSync, because zip.js is
//     built on CompressionStream, Web Workers and a WASM module — none of which
//     exist on Hermes. So the archive layout data/backup.ts defines is written
//     twice, by two containers, and only a round trip run HERE proves this one
//     writes what this one reads. (That the two platforms read EACH OTHER is a
//     third claim, which neither package can make alone — the golden fixtures in
//     packages/shared/src/data/__fixtures__ carry it.)
//   - CONTENT ON DISK. `files/` bytes live decrypted on the filesystem here, not
//     in the row, so the backup reads them off disk and a restore writes them
//     back — two stores that can disagree in silence. A row claiming
//     materialization whose file is gone is the asymmetry web has no shape for.
//   - THE ZIP32 CEILINGS. fflate emits no zip64 and range-checks neither the
//     16-bit entry count nor the 32-bit sizes, so 70 000 entries produce an
//     archive that reads back CLEAN with 65 536 files missing. The guard that
//     refuses to write one is the only thing between a paid-plan library and
//     silent loss, and nothing else exercises it.
//   - NO SAVE DIALOG. The output is a cache file the share sheet is presented
//     over, so the outcome carries `file` and there is nothing to cancel.
//
// Everything above the two native seams runs for real: `expo-sqlite` is the
// node:sqlite shim (the real DDL, the real drizzle driver) and
// `expo-file-system` the in-memory one, which now stores BYTES precisely so a
// zip can survive it.

import { sql } from 'drizzle-orm';
import { unzipSync, zipSync } from 'fflate';

import {
  BACKUP_ITEMS_ENTRY,
  BACKUP_MANIFEST_ENTRY,
  EXTRACTIONS_PREFIX,
  filesListEndpoint,
  filesSignEndpoint,
  LINKS_PREFIX,
  LISTS_PREFIX,
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
import {
  File,
  listFileUris,
  readFileBytes,
  resetFileSystem,
  writeFileBytes,
} from '../testing/memory-file-system';
import { clearCacheFiles } from './cache-files';
import { getDb } from './db';
import { assertZipWritable, exportAllData, ExportTooLargeError } from './export-all-data';
import { dataFileFor, ensureDataFilesDir } from './file-store';
import { importAllData } from './import-all-data';
import { getItem, markItemDataFile, namespaceRows, putItemsTx } from './item-store';
import { liveReadsHeld } from './live-read-invalidation';
import { listPendingOps } from './pending-store';
import { toItemRecord } from './projection';
import { AccountFencedError, beginInitialSync, markFirstSyncDone } from './sync-store';

// The two native seams, and nothing else (../sync/engine.spec.ts, same shims).
jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
// sync/r2.ts deep-imports the legacy surface for its uploads; the cycle these
// specs run never reaches it, this only keeps the native module from loading.
jest.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: { BINARY_CONTENT: 'BINARY_CONTENT' },
  uploadAsync: jest.fn(),
}));
// The cycle below never transfers a blob, but importing the engine loads its
// Expo-native entity transport, which has no native request module under Node.
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
// The crypto boundary is not what this file is about. Every blob it touches is
// already local and already plaintext, so the transforms are never called — but
// the barrel lazily requires quick-crypto, which is native, so it has to be
// replaced wholesale. `newId` stays real in spirit: import mints ids with it,
// and a repeating stub would collapse two imported links onto one path.
jest.mock('@stxapps/expo-crypto', () => ({
  newId: () => globalThis.crypto.randomUUID(),
  encryptEntity: jest.fn(),
  decryptEntity: jest.fn(),
  encryptFile: jest.fn(),
  decryptFile: jest.fn(),
}));
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({
  newId: () => globalThis.crypto.randomUUID(),
}));

const USER = 'alice';
const CURSOR = 1000;

// The op-log window has to CONTAIN the cursor. A blank one (`newestUpdatedAt:
// null`) reads as "empty/wiped log under a returning client" and sends the cycle
// down the fallback path, which deletes local records the server no longer
// lists — i.e. it wipes the seeded library before the export reads it, and the
// export then succeeds reporting zero of everything. Same trap as web's copy.
function deps(): SyncDeps {
  return {
    username: USER,
    encryptionKey: new Uint8Array(32),
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
  } as unknown as SyncDeps;
}

// --- the library under test -----------------------------------------------------

const RANKS = ranksBetween(null, null, 4);
const T = 1_700_000_000_000;

const ENTITIES: { path: string; data: object }[] = [
  {
    path: `${LISTS_PREFIX}work.enc`,
    data: { id: 'work', name: 'Work', parentId: null, rank: RANKS[0], createdAt: T, updatedAt: T },
  },
  {
    path: `${TAGS_PREFIX}read.enc`,
    data: {
      id: 'read',
      name: 'reading',
      parentId: null,
      rank: RANKS[1],
      createdAt: T,
      updatedAt: T,
    },
  },
  {
    path: `${LINKS_PREFIX}l_work.enc`,
    data: {
      url: 'https://work.invalid/spec',
      listId: 'work',
      tagIds: ['read'],
      customTitle: 'The spec',
      customImageId: 'img_work',
      createdAt: T + 2,
      updatedAt: T + 2,
    },
  },
  {
    path: `${LINKS_PREFIX}l_trash.enc`,
    data: {
      url: 'https://trash.invalid/gone',
      listId: TRASH_ID,
      tagIds: [],
      createdAt: T + 1,
      updatedAt: T + 1,
    },
  },
  {
    path: `${EXTRACTIONS_PREFIX}l_work.enc`,
    data: { id: 'l_work', facets: {}, createdAt: T, updatedAt: T },
  },
  {
    path: `${PINS_PREFIX}l_work.enc`,
    data: { id: 'l_work', rank: RANKS[2], createdAt: T, updatedAt: T },
  },
  { path: SETTINGS_GENERAL_PATH, data: { linksLayout: 'list', createdAt: T, updatedAt: T } },
];

// A PNG-ish payload with high bytes in it, deliberately: this is the byte range
// a text-shaped filesystem or a lossy encode hop would mangle, and the round trip
// below is what would notice.
const IMAGE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0xff, 0xfe, 0x00, 0x7f]);
const IMAGE_PATH = 'files/img_work.enc';

function seedEntities(): void {
  getDb().transaction((tx) => {
    for (const { path, data } of ENTITIES) {
      putItemsTx(tx, [toItemRecord(path, 5000, utf8(JSON.stringify(data)))]);
    }
  });
}

// A `files/` blob the way this platform holds one: a row with NO bytes, the
// plaintext on disk, and `hasDataFile` claiming it. All three, because the
// export checks the row AND the file.
async function seedContent(path = IMAGE_PATH, bytes = IMAGE_BYTES): Promise<void> {
  getDb().transaction((tx) => putItemsTx(tx, [toItemRecord(path, 5000)]));
  ensureDataFilesDir();
  const file = dataFileFor(path);
  file.create({ intermediates: true, overwrite: true });
  file.write(bytes);
  await markItemDataFile(path, true);
}

// The store as `{path: json}` — the unit the round trip preserves. A `files/`
// row carries no bytes here, so its DISK contents stand in for its value.
function storedEntities(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prefix of [
    LINKS_PREFIX,
    LISTS_PREFIX,
    TAGS_PREFIX,
    PINS_PREFIX,
    EXTRACTIONS_PREFIX,
    'settings/',
    'files/',
  ]) {
    for (const row of namespaceRows(prefix)) {
      if (prefix === 'files/') {
        const file = dataFileFor(row.path);
        out[row.path] = file.exists ? [...readFileBytes(file.uri)] : null;
      } else if (row.data != null) {
        out[row.path] = JSON.parse(new TextDecoder().decode(row.data));
      }
    }
  }
  return out;
}

async function truncate(): Promise<void> {
  const tables = getDb().all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const { name } of tables) getDb().run(sql.raw(`DELETE FROM "${name}"`));
  await beginInitialSync(USER);
}

async function exportBackup(excludedListIds = new Set<string>()) {
  return await exportAllData({ format: 'bracemark', deps: deps(), excludedListIds });
}

function unzipSaved(uri: string): Record<string, Uint8Array> {
  return unzipSync(readFileBytes(uri));
}

// The archive leaves the app through the share sheet and comes back through the
// document picker, so a restore never reads the file the export wrote — it reads
// a copy that outlived the app's cache. Wiping the store between the two halves
// models that, and means the zip has to be carried across by value.
function stash(uri: string): Uint8Array {
  return Uint8Array.from(readFileBytes(uri));
}

function repick(bytes: Uint8Array, name: string): { uri: string; name: string } {
  const uri = `file:///cache/${name}`;
  writeFileBytes(uri, bytes);
  return { uri, name };
}

beforeEach(async () => {
  await truncate();
  resetFileSystem();
  await beginInitialSync(USER);
  await markFirstSyncDone(USER, CURSOR, `${LINKS_PREFIX}l_seed.enc`);
});

// --- the round trip ---------------------------------------------------------------

describe('the bracemark backup round trip, through fflate', () => {
  it.each([0, 1])('recovers a restore interrupted after %i files', async (completedFiles) => {
    seedEntities();
    await seedContent();
    const before = storedEntities();
    const exported = await exportBackup();
    const archive = stash(exported.file.uri);
    await truncate();
    resetFileSystem();
    const file = repick(archive, exported.file.name);
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
    expect(Object.keys(storedEntities()).filter((path) => path.startsWith(LINKS_PREFIX))).toEqual(
      [],
    );
    const retry = await importAllData({ file, deps: deps(), maxLinks: null });
    expect(retry.linkCount).toBe(2);
    expect(retry.fileCount).toBe(1 - completedFiles);
    expect(storedEntities()).toEqual(before);
  });

  it('rechecks skip-existing inside the write after a restore yields', async () => {
    seedEntities();
    await seedContent();
    const exported = await exportBackup();
    const archive = stash(exported.file.uri);
    await truncate();
    resetFileSystem();
    const file = repick(archive, exported.file.name);
    const path = `${LINKS_PREFIX}l_work.enc`;
    const edited = {
      url: 'https://work.invalid/newer',
      listId: 'my-list',
      tagIds: [],
      customTitle: 'Arrived during restore',
      createdAt: T,
      updatedAt: T + 100,
    };

    const outcome = await importAllData({
      file,
      deps: deps(),
      maxLinks: null,
      onProgress: (progress) => {
        if (progress.step === 'items' && progress.done === 0) {
          getDb().transaction((tx) =>
            putItemsTx(tx, [toItemRecord(path, 6000, utf8(JSON.stringify(edited)))]),
          );
        }
      },
    });

    expect(storedEntities()[path]).toEqual(edited);
    expect(outcome.linkCount).toBe(1);
    expect(outcome.skippedCount).toBe(1);
  });
  // The property the format claims, proved on THIS platform's container: what
  // the streaming Zip writes, unzipSync reads back, entity for entity and byte for byte.
  // A drop on either side is invisible until someone restores a phone.
  it('restores every namespace verbatim into an empty library', async () => {
    seedEntities();
    await seedContent();
    const before = storedEntities();

    const outcome = await exportBackup();
    expect(outcome.linkCount).toBe(2);
    expect(outcome.fileCount).toBe(1);
    expect(outcome.missingFileCount).toBe(0);
    expect(outcome.syncFailed).toBe(false);

    const archive = stash(outcome.file.uri);
    await truncate();
    resetFileSystem();

    const restored = await importAllData({
      file: repick(archive, outcome.file.name),
      deps: deps(),
      maxLinks: null,
    });
    expect(restored.linkCount).toBe(2);
    expect(restored.listCount).toBe(1);
    expect(restored.tagCount).toBe(1);
    expect(restored.fileCount).toBe(1);
    expect(restored.invalidCount).toBe(0);

    expect(storedEntities()).toEqual(before);
  });

  // The streamed zip deflates `items.jsonl` a piece at a time with a yield
  // between pieces (export-all-data.ts ZIP_PIECE, 256 KiB). A library whose
  // lines span several pieces must read back as whole as a one-piece one — a
  // dropped or doubled piece would surface as a torn JSONL line, or as nothing.
  // Non-ASCII notes put multi-byte sequences across the piece boundaries, and
  // through lib/utf8.ts on the way back in.
  it('restores a library whose items span several deflate pieces', async () => {
    seedEntities();
    const note = 'ไทย — naïve café 🧭 '.repeat(20).slice(0, 480);
    getDb().transaction((tx) =>
      putItemsTx(
        tx,
        Array.from({ length: 600 }, (_, n) =>
          toItemRecord(
            `${LINKS_PREFIX}l_bulk_${n}.enc`,
            5000,
            utf8(
              JSON.stringify({
                url: `https://bulk.invalid/${n}`,
                listId: 'work',
                tagIds: ['read'],
                note: `${n} ${note}`,
                createdAt: T + 10 + n,
                updatedAt: T + 10 + n,
              }),
            ),
          ),
        ),
      ),
    );
    const before = storedEntities();

    const outcome = await exportBackup();
    expect(outcome.linkCount).toBe(602);
    const archive = stash(outcome.file.uri);
    expect(unzipSaved(outcome.file.uri)[BACKUP_ITEMS_ENTRY].length).toBeGreaterThan(256 * 1024);

    await truncate();
    resetFileSystem();
    const restored = await importAllData({
      file: repick(archive, outcome.file.name),
      deps: deps(),
      maxLinks: null,
    });
    expect(restored.linkCount).toBe(602);
    expect(restored.invalidCount).toBe(0);
    expect(storedEntities()).toEqual(before);
  });

  // The divergence, from the WRITE side: blob bytes are read off the filesystem,
  // not out of the row. A backup that took the row's `data` would ship an empty
  // entry for every image in the library and still count it as included.
  it('takes a blob from disk and puts it back on disk, high bytes intact', async () => {
    seedEntities();
    await seedContent();

    const outcome = await exportBackup();
    const entries = unzipSaved(outcome.file.uri);
    expect([...entries['files/img_work']]).toEqual([...IMAGE_BYTES]);

    const archive = stash(outcome.file.uri);
    await truncate();
    resetFileSystem();
    await importAllData({
      file: repick(archive, outcome.file.name),
      deps: deps(),
      maxLinks: null,
    });

    // Both halves of the two-store write: the plaintext on disk AND the row's
    // claim about it. A restore that wrote one without the other leaves a link
    // whose image never renders, or one the sync engine re-downloads forever.
    expect([...readFileBytes(dataFileFor(IMAGE_PATH).uri)]).toEqual([...IMAGE_BYTES]);
    expect((await getItem(IMAGE_PATH))?.hasDataFile).toBeTruthy();
  });

  // The drift guard for the file-ref gate. The gate is classifyBundleLine's and
  // is covered field by field in shared data/backup.spec.ts; web's copy of this
  // case is the canonical one. But this importer is its own source, so web
  // passing proves nothing about it — and it has a store web doesn't. A ref the
  // wire contract cannot carry, admitted HERE, is a plaintext file on disk as
  // well as a queued put the request contract refuses on every push, holding the
  // metadata puts and the pull behind it.
  it('refuses a line whose file ref cannot be a sync path — no row, no file, no op', async () => {
    // A filename for an id, as an archive written by something that isn't this
    // app would plausibly carry. No first-party writer mints one (ids are UUIDs).
    const badId = 'cover.png';
    const badLink = `${LINKS_PREFIX}l_bad.enc`;
    const badFile = `files/${badId}.enc`;
    seedEntities();
    await seedContent();
    getDb().transaction((tx) =>
      putItemsTx(tx, [
        toItemRecord(
          badLink,
          5000,
          utf8(
            JSON.stringify({
              url: 'https://bad.invalid/',
              listId: 'work',
              tagIds: [],
              customImageId: badId,
              createdAt: T + 3,
              updatedAt: T + 3,
            }),
          ),
        ),
      ]),
    );
    await seedContent(badFile);

    const outcome = await exportBackup();
    expect(Object.keys(unzipSaved(outcome.file.uri))).toContain(`files/${badId}`);
    const archive = stash(outcome.file.uri);
    await truncate();
    resetFileSystem();

    const restored = await importAllData({
      file: repick(archive, outcome.file.name),
      deps: deps(),
      maxLinks: null,
    });

    // Reported, and not fatal: the two good links and their blob still land.
    expect(restored.invalidCount).toBe(1);
    expect(restored.linkCount).toBe(2);
    expect(restored.fileCount).toBe(1);
    expect(await getItem(badLink)).toBeUndefined();
    expect(await getItem(badFile)).toBeUndefined();
    expect(dataFileFor(badFile).exists).toBe(false);

    const queued = (await listPendingOps(USER)).map((o) => o.path);
    for (const path of queued) expect(syncPathSchema.safeParse(path).success).toBe(true);
    // …and the queue is not simply empty.
    expect(queued).toContain(IMAGE_PATH);
  });

  // The other side of the same asymmetry: the row claims materialization and the
  // file is gone (an OS cache eviction, an interrupted teardown). The archive
  // ships without it and says so, rather than writing a zero-length entry that
  // restores as a corrupt image.
  it('counts a claimed blob whose file has vanished as missing', async () => {
    seedEntities();
    await seedContent();
    dataFileFor(IMAGE_PATH).delete();

    const outcome = await exportBackup();
    expect(outcome.fileCount).toBe(0);
    expect(outcome.missingFileCount).toBe(1);
    const entries = unzipSaved(outcome.file.uri);
    expect(Object.keys(entries)).toEqual([BACKUP_MANIFEST_ENTRY, BACKUP_ITEMS_ENTRY]);
  });

  // The drift guard, not a port of web's matrix: one case each for the two
  // policies, so editing THIS orchestrator's copy fails here. A spec passing on
  // web's source proves nothing about this file — they are duplicated source.
  it('keeps Trash in the backup and a locked list out of it', async () => {
    seedEntities();
    await seedContent();

    const kept = unzipSaved((await exportBackup()).file.uri);
    const items = new TextDecoder().decode(kept[BACKUP_ITEMS_ENTRY]);
    expect(items).toContain('https://trash.invalid/gone');

    const locked = unzipSaved((await exportBackup(new Set(['work']))).file.uri);
    const lockedItems = new TextDecoder().decode(locked[BACKUP_ITEMS_ENTRY]);
    expect(lockedItems).not.toContain('https://work.invalid/spec');
    expect(lockedItems).not.toContain('"name":"Work"');
    expect(lockedItems).not.toContain(`${PINS_PREFIX}l_work.enc`);
    // The positive control for the three negatives above — the run still carried
    // the link that was not in the locked list.
    expect(lockedItems).toContain('https://trash.invalid/gone');
  });

  // Skip-existing by path, on this platform's store. The failure it prevents is
  // a restore silently rolling back edits made since the backup.
  it('never clobbers a path the local store already holds', async () => {
    seedEntities();
    await seedContent();
    const outcome = await exportBackup();

    const edited = {
      url: 'https://work.invalid/spec',
      listId: 'work',
      tagIds: ['read'],
      customTitle: 'The spec, revised',
      customImageId: 'img_work',
      createdAt: T + 2,
      updatedAt: T + 9,
    };
    getDb().transaction((tx) => {
      putItemsTx(tx, [
        toItemRecord(`${LINKS_PREFIX}l_work.enc`, 6000, utf8(JSON.stringify(edited))),
      ]);
    });

    const restored = await importAllData({
      file: repick(stash(outcome.file.uri), outcome.file.name),
      deps: deps(),
      maxLinks: null,
    });

    expect(storedEntities()[`${LINKS_PREFIX}l_work.enc`]).toEqual(edited);
    expect(restored.skippedCount).toBeGreaterThan(0);
  });
});

// --- the live-read hold -----------------------------------------------------------

// The import holds live reads (live-read-invalidation.ts) so they re-run on a flush
// rather than after every write chunk. A hold left behind is the silent failure:
// every live read on screen would then re-run only every couple of seconds, for the
// life of the app, with nothing to say why.
describe('the live-read hold', () => {
  it('does not hold unrelated live reads while waiting for a quota answer', async () => {
    let heldAtPrompt: boolean | undefined;
    await expect(
      importAllData({
        file: repick(utf8('https://a.invalid/one\nhttps://b.invalid/two\n'), 'links.txt'),
        deps: deps(),
        maxLinks: 1,
        onQuotaPrompt: async () => {
          heldAtPrompt = liveReadsHeld();
          return 'cancel';
        },
      }),
    ).rejects.toThrow();
    expect(heldAtPrompt).toBe(false);
    expect(liveReadsHeld()).toBe(false);
  });

  it('releases the hold when a write phase fails', async () => {
    await expect(
      importAllData({
        file: repick(utf8('https://a.invalid/one'), 'links.txt'),
        deps: deps(),
        maxLinks: null,
        onProgress: (progress) => {
          if (progress.step === 'items') {
            expect(liveReadsHeld()).toBe(true);
            throw new Error('write failed');
          }
        },
      }),
    ).rejects.toThrow('write failed');
    expect(liveReadsHeld()).toBe(false);
  });

  it('is held while the chunks are written and released when the import ends', async () => {
    const heldWhileWriting: boolean[] = [];

    await importAllData({
      file: repick(utf8('https://a.invalid/one\nhttps://b.invalid/two\n'), 'links.txt'),
      deps: deps(),
      maxLinks: null,
      onProgress: (progress) => {
        if (progress.step === 'items') heldWhileWriting.push(liveReadsHeld());
      },
    });

    expect(heldWhileWriting.length).toBeGreaterThan(0);
    expect(heldWhileWriting.every(Boolean)).toBe(true);
    expect(liveReadsHeld()).toBe(false);
  });

  it('is released when the import fails', async () => {
    const notAnExport = zipSync({ 'photo.bin': new Uint8Array([1, 2, 3]) });

    await expect(
      importAllData({ file: repick(notAnExport, 'photos.zip'), deps: deps(), maxLinks: null }),
    ).rejects.toThrow('neither a Bracemark backup nor a bookmarks export');

    expect(liveReadsHeld()).toBe(false);
  });
});

// --- what only this platform can lose -----------------------------------------------

describe('the zip32 ceilings fflate does not check', () => {
  // 70 000 entries write `70000 & 0xffff` = 4 464 into the 16-bit count field and
  // hand back an archive that READS BACK CLEAN with 65 536 files missing. The
  // ceilings sit inside what the paid plans sell (maxFiles 1 000 000, maxBytes up
  // to 20 GiB), so this is reachable rather than theoretical, and refusing to
  // write is the only correct answer: there is no failure signal anywhere
  // downstream — not in fflate, not in the archive, not in a restore.
  //
  // Asserted at the guard rather than through the orchestrator, which is the only
  // place it can be: crossing either ceiling for real needs 65 536 materialized
  // blobs each referenced by a link, or 4 GiB of them.
  const entries = (count: number, size = 0): [string, Uint8Array][] =>
    Array.from({ length: count }, (_, i) => [`files/f_${i}`, new Uint8Array(size)]);

  // The boundary in both directions — a `>` that slipped to `>=` would refuse a
  // library zip32 can represent, and a `>=` that slipped to `>` would write the
  // corrupt one.
  it('takes exactly as many entries as zip32 can count, and refuses one more', () => {
    expect(() => assertZipWritable(entries(65_535))).not.toThrow();
    expect(() => assertZipWritable(entries(65_536))).toThrow(ExportTooLargeError);
  });

  // The size ceiling is the 32-bit offset field, and it is an ESTIMATE of the
  // archive rather than a sum of payloads — per-entry overhead and the name are
  // part of what overflows. Fed a length rather than 4 GiB of memory.
  it('refuses an archive past the 32-bit size field', () => {
    const huge: [string, Uint8Array][] = [['files/big', { length: 0xffff_ffff } as Uint8Array]];
    expect(() => assertZipWritable(huge)).toThrow(ExportTooLargeError);
  });

  // The message is rendered verbatim by the export view, and it is the only
  // place a user is told where the backup CAN be made — a refusal without that
  // sentence is a dead end.
  it('names the web app in the refusal, since that is the way out', () => {
    expect(() => assertZipWritable(entries(65_536))).toThrow(/Bracemark web app/);
  });
});

describe('the output the share sheet is presented over', () => {
  // No save dialog on this platform, so the outcome has to carry where the file
  // landed — the UI has nothing else to share, and an outcome without it is a
  // successful export the user can never reach.
  it("names a real cache file with the format's own mime type", async () => {
    seedEntities();
    const outcome = await exportBackup();

    expect(outcome.file.name).toMatch(/^Bracemark backup .*\.zip$/);
    expect(outcome.file.mimeType).toBe('application/zip');
    expect(outcome.file.uri.startsWith('file:///cache/')).toBe(true);
    expect(readFileBytes(outcome.file.uri).length).toBeGreaterThan(0);
  });

  // That file is the whole library in plaintext, and it has to outlive the run for the
  // share sheet to read it — so it lands where the sign-out wipe looks for it
  // (cache-files.ts), not loose in the cache dir under a name only this run knows.
  it('writes it where the sign-out wipe will find it', async () => {
    seedEntities();
    const outcome = await exportBackup();

    clearCacheFiles();

    expect(new File(outcome.file.uri).exists).toBe(false);
  });

  // A run takes minutes and holds the gathered library in memory, so a sign-out midway
  // used to end with the signed-out account's backup written AFTER the wipe had swept the
  // cache dir. The write is fenced on the account like a store write.
  it('writes nothing for an account that signed out while it ran', async () => {
    seedEntities();
    const running = exportAllData({
      format: 'netscape',
      deps: {
        ...deps(),
        api: {
          call: async () => {
            // The sign-out lands during the run's refresh, before anything is written.
            getDb().run(sql`DELETE FROM sync_meta`);
            throw new Error('offline');
          },
        } as unknown as SyncDeps['api'],
      },
      excludedListIds: new Set<string>(),
    });

    await expect(running).rejects.toBeInstanceOf(AccountFencedError);
    expect(listFileUris().filter((uri) => uri.startsWith('file:///cache/'))).toEqual([]);
  });
});

// --- the cross-platform half --------------------------------------------------------

describe('the golden archives', () => {
  // The mirror of web-react's copy, and the claim neither package can make alone:
  // this platform reads what WEB wrote. zip.js and fflate are two containers for
  // one layout, and @nx/enforce-module-boundaries means no single spec can hold
  // both — so the artifacts are the seam (tools/scripts/generate-backup-fixtures.ts,
  // kept honest by packages/shared/src/data/backup-fixtures.spec.ts).
  // Addressed through the package rather than by counting directories up to
  // `packages/`: nothing checks a path spelled as a string, so a `shared` that
  // moved would fail here as a missing file rather than as a boundary error.
  const contents = readBackupFixtureContents();

  // Both, and not just the foreign one: fflate's own archive is the regression
  // guard for THIS container across an fflate upgrade — the other way a backup
  // made last year stops restoring.
  it.each<BackupFixtureArchive>(['backup-web.zip', 'backup-expo.zip'])(
    'restores %s into this platform, entities and blob bytes intact',
    async (name) => {
      const picked = repick(new Uint8Array(readBackupFixture(name)), name);
      const outcome = await importAllData({ file: picked, deps: deps(), maxLinks: null });
      expect(outcome.invalidCount).toBe(0);
      expect(outcome.skippedCount).toBe(0);

      const stored = storedEntities();
      for (const { path, data } of contents.entities) {
        expect(stored[path]).toEqual(data);
      }
      // On this platform the bytes land on DISK, so "restored" means the file is
      // there — the row deliberately carries none.
      for (const { id, bytes } of contents.files) {
        expect(stored[`files/${id}.enc`]).toEqual(bytes);
      }
    },
  );
});
