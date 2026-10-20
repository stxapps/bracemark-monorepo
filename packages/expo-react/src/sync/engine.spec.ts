// Sync-engine specs for the EXPO engine — deliberately NOT a port of
// web-react's engine.spec.ts. That file is the canonical end-to-end coverage of
// the CYCLE (docs/local-first-sync.md — a sync cycle), and re-asserting the
// protocol against a second copy of the same logic would mostly restate it.
// What it cannot cover is the half that only exists here: `files/` content lives
// DECRYPTED ON DISK (data/file-store.ts), not as bytes in the row, so every
// content flow is a two-store write — a SQLite row and a file — and the two can
// disagree in ways nothing else catches:
//
//  - a pull that re-stores a content row must tear down the stale plaintext,
//    but ONLY for the rows it actually re-stored: a path spared by the
//    local-wins guard still has a queued op whose upload reads that file, and
//    deleting it strands the user's content with no error, no pending count and
//    no retry;
//  - the same asymmetry on the delete side (applyDeletes);
//  - `uploadOne`'s content branch, where "no payload" is a TWO-part test
//    (`!rec.hasDataFile || !plain.exists`) that web spells as one;
//  - `loadEntityContent`, which DIVERGES in behaviour, not just mechanism: web
//    still returns the bytes when it loses the restamp race, this returns
//    undefined and discards the plaintext it just wrote;
//  - and the in-transit ciphertext temp files, which must be gone however a
//    transfer settles.
//
// The last three describes are the exception to the "don't restate the
// protocol" rule: the two engines are duplicated SOURCE, not shared source, so
// nothing catches expo-side drift on the phase order, the orphan self-heal or
// the quota gate. Those are near-free once this harness exists, so they stay as
// drift guards — thinned to one case each, not the full web matrix.
//
// The harness shims only the two native seams and runs everything above them
// for real: `expo-sqlite` → the node:sqlite shim (so the real DDL, the real
// drizzle driver, the real guarded writes run), and `expo-file-system` → an
// in-memory filesystem (so the real file-store owns the directory and the
// path↔location mapping). The write edge is the real mutations.ts, which is
// what puts a mid-cycle write after the pending snapshot deterministically,
// with no timers.

import { eq, sql } from 'drizzle-orm';

import { decryptEntity, decryptFile, encryptEntity, encryptFile } from '@stxapps/expo-crypto';
import {
  ApiError,
  BlobUnreadableError,
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  filesListEndpoint,
  filesSignEndpoint,
  LINKS_PREFIX,
  opsCommitEndpoint,
  opsListEndpoint,
  pathFromId,
  SET_OUTAGE_FAILURES,
  utf8,
} from '@stxapps/shared';

import { getDb, itemTagIds, syncMeta } from '../data/db';
import { dataFileFor, ensureDataFilesDir } from '../data/file-store';
import { getItem, markItemDataFile, putItemsTx, stampItemUpdatedAts } from '../data/item-store';
import { liveReadsHeld } from '../data/live-read-invalidation';
import { writeExtraction, writeFile } from '../data/mutations';
import { enqueueDeleteTx, enqueuePutTx, listPendingOps } from '../data/pending-store';
import { toItemRecord } from '../data/projection';
import {
  beginInitialSync,
  getSyncMeta,
  isFirstSyncDone,
  markFirstSyncDone,
} from '../data/sync-store';
import {
  File as MemFile,
  listFileUris,
  Paths as MemPaths,
  readFileText,
  resetFileSystem,
  writeFileText,
} from '../testing/memory-file-system';
import {
  holdSyncCycles,
  loadEntityContent,
  loadEntityContents,
  runIncrementalSync,
  runInitialSync,
  type SyncDeps,
} from './engine';
import { BlobRequestError, getBlob, getBlobToFile, putBlob, putBlobFromFile } from './r2';

// The expo-crypto stand-in below throws this; jest's hoisting lets a factory
// reach an outer binding only by a `mock` prefix, and only once it runs.
const mockBlobUnreadableError = BlobUnreadableError;

// The one seam that would reach native sqlite; everything above it in db.ts —
// getDb, the PRAGMA, the DDL, the schema objects — runs for real
// (data/item-store.spec.ts, same shim).
jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));
// The other native seam. The REAL data/file-store.ts runs on top of it.
jest.mock('expo-file-system', () => require('../testing/memory-file-system'));
// r2's upload transport is the legacy native module. It is stubbed wholesale
// below; this only keeps `requireActual('./r2')` — which we want, for the real
// BlobRequestError the engine branches on with `instanceof` — from loading it.
jest.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: { BINARY_CONTENT: 'BINARY_CONTENT' },
  uploadAsync: jest.fn(),
}));
// The real native fetch is exercised on-device; Node has no Expo native request
// module, and requireActual('./r2') below only needs the error class.
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

// The crypto boundary is not what these specs are about: reversible stand-ins
// keep the assertions on what the pipeline actually MOVED, so "the local copy
// survived" is checkable by value on both paths. The entity pair prefixes a
// marker byte; the FILE pair is path-to-path, like the native module, and
// prefixes a marker string — so a plaintext that never reached disk, or a
// ciphertext uploaded from the wrong file, is visible in the assertion.
jest.mock('@stxapps/expo-crypto', () => {
  const fs =
    require('../testing/memory-file-system') as typeof import('../testing/memory-file-system');
  return {
    encryptEntity: jest.fn(
      async (_key: Uint8Array, bytes: Uint8Array) => new Uint8Array([0xee, ...bytes]),
    ),
    decryptEntity: jest.fn(async (_key: Uint8Array, bytes: Uint8Array) => bytes.slice(1)),
    encryptFile: jest.fn(async (input: string, output: string) => {
      fs.writeFileText(output, `enc:${fs.readFileText(input)}`);
    }),
    decryptFile: jest.fn(async (input: string, output: string, _key: unknown, path: string) => {
      const cipher = fs.readFileText(input);
      // GCM authenticates at the end of the stream: a bad tag rejects and leaves
      // no output behind, as BlobUnreadableError (expo-crypto lib/file-crypto.ts).
      // Through the static import's `mock`-prefixed alias, not a require of the
      // package: one would make the boundary rule read it as lazy-loaded
      // (docs/testing.md, the tripwire).
      if (!cipher.startsWith('enc:')) throw new mockBlobUnreadableError(path);
      fs.writeFileText(output, cipher.slice('enc:'.length));
    }),
    // Kept real in spirit — file-store mints temp names with it, and two
    // concurrent transfers must not collide.
    newId: () => globalThis.crypto.randomUUID(),
  };
});
// pending-store deep-imports this one (the barrel would drag in quick-crypto).
// UNIQUE per call: `writeId` identity is what compare-and-delete rests on, and a
// repeating stub would make it pass vacuously.
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({
  newId: () => globalThis.crypto.randomUUID(),
}));

// R2 is reached over presigned URLs; stub the four movers (two per direction,
// split by payload — sync/r2.ts). The real BlobRequestError class is kept
// because the engine branches on `instanceof` for 404s.
jest.mock('./r2', () => {
  const actual = jest.requireActual<typeof import('./r2')>('./r2');
  return {
    ...actual,
    getBlob: jest.fn(),
    putBlob: jest.fn(),
    getBlobToFile: jest.fn(),
    putBlobFromFile: jest.fn(),
  };
});

const mockGetBlob = getBlob as jest.MockedFunction<typeof getBlob>;
const mockPutBlob = putBlob as jest.MockedFunction<typeof putBlob>;
const mockGetBlobToFile = getBlobToFile as jest.MockedFunction<typeof getBlobToFile>;
const mockPutBlobFromFile = putBlobFromFile as jest.MockedFunction<typeof putBlobFromFile>;

const USER = 'alice';
const LINK_PATH = pathFromId('l_a', LINKS_PREFIX);
const OTHER_LINK_PATH = pathFromId('l_b', LINKS_PREFIX);
const EXTRACTION_PATH = pathFromId('l_a', EXTRACTIONS_PREFIX);
const FILE_ID = 'f_a';
const FILE_PATH = pathFromId(FILE_ID, FILES_PREFIX);
const OTHER_FILE_ID = 'f_b';
const OTHER_FILE_PATH = pathFromId(OTHER_FILE_ID, FILES_PREFIX);

// --- the api stub ------------------------------------------------------------

interface OpsListReply {
  ops: { op: 'put' | 'delete'; path: string; updatedAt: number }[];
  oldestUpdatedAt: number | null;
  newestUpdatedAt: number | null;
  hasMore: boolean;
}

interface Handlers {
  // Handed the cursor it was asked from, for the one case that is about paging.
  opsList?: (asked: { since?: number; sincePath?: string }) => Promise<OpsListReply> | OpsListReply;
  filesList?: () =>
    Promise<{ path: string; updatedAt: number }[]> | { path: string; updatedAt: number }[];
  // A listing in pages, for the specs about what happens between them. Wins over
  // `filesList` when both are set.
  filesListPage?: (pageToken: string | undefined) => Promise<{
    files: { path: string; updatedAt: number }[];
    nextPageToken: string | null;
  }>;
  // The hook a test uses to land a write mid-cycle — it runs after the pending
  // snapshot and before the apply. `op` is passed so a handler can refuse PUT
  // signing while leaving GETs alone, the way the quota gate does.
  filesSign?: (paths: string[], op: 'put' | 'get') => Promise<string[] | void> | string[] | void;
  opsCommit?: (paths: string[]) => Promise<void> | void;
  commitUpdatedAt?: number;
}

// Every commit the cycle made, in call order — the phase-ordering assertions
// read this.
let commits: { op: string; path: string }[][];
// Every files/sign request's transport, in order.
let signVias: unknown[];
// R2 objects this fake server holds, so `ops/commit` can enforce the real
// op-without-object rule instead of rubber-stamping every op.
let uploaded: Set<string>;
// What each content PUT actually sent, read off the temp ciphertext file the
// upload was pointed at.
let uploadedFiles: Map<string, string>;
// The plaintext R2 holds for a content path, for the download direction.
let r2Content: Map<string, string>;

const urlFor = (path: string): string => `https://r2.test/${path}`;
const pathFor = (url: string): string => url.slice('https://r2.test/'.length);
// The blob route's token for a path, as files/sign answers a `via: 'api'`
// request beside the URL — what every transfer must send as its header. The URLs
// stay per-path so a mock can tell transfers apart; the engine treats both as
// opaque.
const tokenFor = (path: string): string => `Blob token-for-${path}`;
// What the blob route answers a PUT with: the upload receipt the commit carries
// back (sync/r2.ts). As opaque to the engine as the token.
const receiptFor = (path: string): string => `receipt-for-${path}`;

// An ApiClient that dispatches on endpoint IDENTITY (not path strings), so a
// renamed route can't silently turn a handler into the "unexpected endpoint"
// throw below.
function makeApi(handlers: Handlers = {}): SyncDeps['api'] {
  const empty: OpsListReply = {
    ops: [],
    oldestUpdatedAt: null,
    newestUpdatedAt: null,
    hasMore: false,
  };
  return {
    call: async (endpoint: unknown, input: Record<string, unknown>) => {
      if (endpoint === opsListEndpoint) {
        const asked = { since: input.since, sincePath: input.sincePath } as {
          since?: number;
          sincePath?: string;
        };
        return (await handlers.opsList?.(asked)) ?? empty;
      }
      if (endpoint === filesListEndpoint) {
        if (handlers.filesListPage) {
          return handlers.filesListPage(input.pageToken as string | undefined);
        }
        return { files: (await handlers.filesList?.()) ?? [], nextPageToken: null };
      }
      if (endpoint === filesSignEndpoint) {
        const paths = input.paths as string[];
        const granted = (await handlers.filesSign?.(paths, input.op as 'put' | 'get')) ?? paths;
        signVias.push(input.via);
        return {
          urls: granted.map((path) => ({ path, url: urlFor(path), authorization: tokenFor(path) })),
        };
      }
      if (endpoint === opsCommitEndpoint) {
        const ops = input.ops as { op: 'put' | 'delete'; path: string }[];
        commits.push(ops);
        await handlers.opsCommit?.(ops.map((o) => o.path));
        // A `put` whose object never landed is REFUSED, exactly as bracemark-api
        // refuses it (`failed: no_object`) — which is what leaves the path queued.
        const landed = ops.filter((o) => o.op === 'delete' || uploaded.has(o.path));
        return {
          results: landed.map((o) => ({
            path: o.path,
            updatedAt: handlers.commitUpdatedAt ?? 9000,
          })),
          failed: ops
            .filter((o) => !landed.includes(o))
            .map((o) => ({ path: o.path, reason: 'no_object' })),
        };
      }
      throw new Error('unexpected endpoint');
    },
    // The stub sidesteps the generic contract types; the engine only calls `.call`.
  } as unknown as SyncDeps['api'];
}

function deps(handlers: Handlers = {}): SyncDeps {
  return { username: USER, encryptionKey: new Uint8Array(32), api: makeApi(handlers) };
}

// --- local-store helpers -----------------------------------------------------

// A synced entity record with no local edit outstanding: bytes + the server's
// stamp, no op.
function seedSynced(path: string, body: string, updatedAt: number): void {
  getDb().transaction((tx) => putItemsTx(tx, [toItemRecord(path, updatedAt, utf8(body))]));
}

// The write edge's own shape (mutations.ts writeEntityWith): the record and its
// pending op in ONE transaction. Through the real enqueue, so the row carries a
// fresh `writeId`.
function seedQueued(path: string, body: string, baseUpdatedAt = 0): void {
  getDb().transaction((tx) => {
    putItemsTx(tx, [toItemRecord(path, baseUpdatedAt, utf8(body))]);
    enqueuePutTx(tx, USER, path, baseUpdatedAt);
  });
}

// A synced CONTENT record, materialized: the row (blob-less, by definition) plus
// its decrypted plaintext on disk and the `hasDataFile` claim over it.
async function seedSyncedContent(
  path: string,
  plaintext: string,
  updatedAt: number,
): Promise<void> {
  ensureDataFilesDir();
  writeFileText(dataFileFor(path).uri, plaintext);
  getDb().transaction((tx) => putItemsTx(tx, [toItemRecord(path, updatedAt)]));
  await markItemDataFile(path, true);
}

// A queued content write, through the REAL write edge — plaintext copied onto
// the store's location, row + op in one transaction, `hasDataFile` marked last.
async function seedQueuedContent(fileId: string, plaintext: string): Promise<void> {
  const source = new MemFile(MemPaths.cache, `picked-${fileId}`);
  writeFileText(source.uri, plaintext);
  await writeFile(USER, fileId, source as unknown as Parameters<typeof writeFile>[2]);
}

function pendingPaths(): Promise<string[]> {
  return listPendingOps(USER).then((ops) => ops.map((o) => o.path).sort());
}

async function bodyAt(path: string): Promise<string | undefined> {
  const rec = await getItem(path);
  return rec?.data ? new TextDecoder().decode(rec.data) : undefined;
}

// The decrypted content on disk for a path, or undefined if not materialized.
function plaintextAt(path: string): string | undefined {
  const file = dataFileFor(path);
  return file.exists ? readFileText(file.uri) : undefined;
}

// In-transit ciphertext. Every transfer must clean up after itself however it
// settled — a leak here is invisible on device until the cache fills.
function tempFiles(): string[] {
  return listFileUris().filter((uri) => uri.includes('/bracemark-scratch/'));
}

const committedPaths = (): string[] => commits.flat().map((o) => o.path);

// The real shape of a presigned PUT that outlived its 5-min TTL — R2 answers
// 403, which the transports raise as this.
const EXPIRED_URL = new BlobRequestError('PUT', 403);

// Make the named paths' uploads fail while every other path still lands, on both
// transports.
function failUploadsFor(...paths: string[]): void {
  const failing = new Set(paths);
  mockPutBlob.mockImplementation(async (url: string) => {
    if (failing.has(pathFor(url))) throw EXPIRED_URL;
    uploaded.add(pathFor(url));
    return receiptFor(pathFor(url));
  });
  mockPutBlobFromFile.mockImplementation(async (url: string, file: { uri: string }) => {
    if (failing.has(pathFor(url))) throw EXPIRED_URL;
    uploaded.add(pathFor(url));
    uploadedFiles.set(pathFor(url), readFileText(file.uri));
    return receiptFor(pathFor(url));
  });
}

// Run `start` to its end with the blob retry's backoff skipped: fake timers,
// stepped until it settles. Resolves with its value or its rejection. Only the
// backoff's timers are faked; the sqlite shim and the file mock keep running on
// the real loop.
async function settleSkippingBackoff(start: () => Promise<unknown>): Promise<unknown> {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  try {
    let settled = false;
    const outcome = start().then(
      (value) => value,
      (err: unknown) => err,
    );
    void outcome.finally(() => {
      settled = true;
    });
    for (let step = 0; !settled && step < 100; step++) await jest.advanceTimersByTimeAsync(500);
    return await outcome;
  } finally {
    jest.useRealTimers();
  }
}

beforeEach(async () => {
  commits = [];
  signVias = [];
  uploaded = new Set();
  uploadedFiles = new Map();
  r2Content = new Map();
  jest.clearAllMocks();

  mockPutBlob.mockImplementation(async (url: string) => {
    uploaded.add(pathFor(url));
    return receiptFor(pathFor(url));
  });
  mockPutBlobFromFile.mockImplementation(async (url: string, file: { uri: string }) => {
    uploaded.add(pathFor(url));
    uploadedFiles.set(pathFor(url), readFileText(file.uri));
    return receiptFor(pathFor(url));
  });
  mockGetBlobToFile.mockImplementation(async (url: string, file: { uri: string }) => {
    const plain = r2Content.get(pathFor(url));
    if (plain === undefined) throw new BlobRequestError('GET', 404);
    writeFileText(file.uri, `enc:${plain}`);
  });

  // `getDb()` memoizes its connection, so the whole file shares one database
  // (jest gives each spec FILE a fresh module registry). Truncate rather than
  // reopen, enumerating from `sqlite_master` so a table added to the DDL is
  // cleared automatically (data/item-store.spec.ts).
  const tables = getDb().all<{ name: string }>(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  for (const { name } of tables) getDb().run(sql.raw(`DELETE FROM "${name}"`));
  resetFileSystem();

  // Past the first-sync gate, with a cursor inside the op log's retained range
  // so a test picks its cycle by what it makes ops/list answer, not by leftover
  // state.
  await beginInitialSync(USER);
  await markFirstSyncDone(USER, 1000, 'links/l_seed.enc');
});

// --- the fan-out --------------------------------------------------------------

// Web engine's spec carries the reading behind these. Here the size that picks a
// content upload's fan-out is the plaintext file's, read before anything is sent.
describe('the fan-out', () => {
  it('sends small content wide, and holds large content to the narrow gate', async () => {
    const LARGE = 'x'.repeat(70 * 1024);
    for (let i = 0; i < 12; i++) await seedQueuedContent(`big_${i}`, LARGE);
    for (let i = 0; i < 12; i++) await seedQueuedContent(`small_${i}`, 'tiny');
    const inFlight = { large: 0, small: 0 };
    const maxInFlight = { large: 0, small: 0 };
    mockPutBlobFromFile.mockImplementation(async (url: string) => {
      const kind = pathFor(url).includes('big_') ? 'large' : 'small';
      inFlight[kind] += 1;
      maxInFlight[kind] = Math.max(maxInFlight[kind], inFlight[kind]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight[kind] -= 1;
      uploaded.add(pathFor(url));
      return receiptFor(pathFor(url));
    });

    await runIncrementalSync(deps());

    expect(maxInFlight.large).toBe(8);
    expect(maxInFlight.small).toBe(12);
    expect(await pendingPaths()).toEqual([]);
    expect(tempFiles()).toEqual([]);
  });

  it('stops a put set at a failed commit, and leaves the rest queued', async () => {
    // Two content chunks (100 each) are what put a sign beside a commit; the
    // links are the metadata phase the failure must keep from starting.
    for (let i = 0; i < 150; i++) seedQueued(pathFromId(`l_${i}`, LINKS_PREFIX), 'bytes');
    for (let i = 0; i < 150; i++) await seedQueuedContent(`f_${i}`, 'bytes');
    const refused = new ApiError(400, JSON.stringify({ error: 'bad_request' }));
    let putSigns = 0;

    await expect(
      runIncrementalSync(
        deps({
          filesSign: (_paths, op) => {
            if (op === 'put') putSigns += 1;
          },
          opsCommit: () => {
            throw refused;
          },
        }),
      ),
    ).rejects.toBe(refused);

    // The first content chunk's commit failed; the second was signed and uploaded
    // beside it and never committed, and the metadata phase never started.
    expect(commits).toHaveLength(1);
    expect(putSigns).toBe(2);
    expect(await pendingPaths()).toHaveLength(300);
  }, 30_000);

  it('fetches a first sync’s listed page while the next is still listing', async () => {
    // No first-sync flag — this IS the first sync (the shared beforeEach seeds a
    // returning client).
    getDb().delete(syncMeta).run();
    await beginInitialSync(USER);
    mockGetBlob.mockImplementation(
      async (url: string) => new Uint8Array([0xee, ...utf8(pathFor(url))]),
    );

    let releaseSecondPage = (): void => undefined;
    const ticks: [number, number][] = [];
    const pull = runInitialSync(
      deps({
        filesListPage: async (pageToken) => {
          if (pageToken === undefined) {
            return {
              files: [
                { path: LINK_PATH, updatedAt: 100 },
                { path: OTHER_LINK_PATH, updatedAt: 101 },
              ],
              nextPageToken: 'page-2',
            };
          }
          await new Promise<void>((resolve) => (releaseSecondPage = resolve));
          return { files: [{ path: EXTRACTION_PATH, updatedAt: 102 }], nextPageToken: null };
        },
      }),
      (done, total) => ticks.push([done, total]),
    );

    for (let i = 0; i < 1000 && (await bodyAt(OTHER_LINK_PATH)) === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(await bodyAt(LINK_PATH)).toBe(LINK_PATH);
    expect(await bodyAt(OTHER_LINK_PATH)).toBe(OTHER_LINK_PATH);
    expect(ticks).toEqual([]);

    releaseSecondPage();
    await pull;

    expect(await bodyAt(EXTRACTION_PATH)).toBe(EXTRACTION_PATH);
    expect(ticks.every(([, total]) => total === 3)).toBe(true);
    expect(ticks.at(-1)).toEqual([3, 3]);
  });

  it('does not reject a first sync while a GET it started is still storing', async () => {
    // Drift guard for feedPull (web engine's spec, _a first sync_, has the case):
    // the outage stop fails the fan-out mid-listing, and the pull waits out the
    // GETs in flight before it rejects.
    getDb().delete(syncMeta).run();
    await beginInitialSync(USER);
    const expired = new BlobRequestError('GET', 403);
    const failing = Array.from(
      { length: SET_OUTAGE_FAILURES },
      (_, i) => `links/fail_${String(i).padStart(2, '0')}.enc`,
    );
    const slow = 'links/slow_a.enc';
    mockGetBlob.mockImplementation(async (url: string) => {
      const path = pathFor(url);
      if (failing.includes(path)) throw expired;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Uint8Array([0xee, ...utf8(path)]);
    });

    await expect(
      runInitialSync(
        deps({
          filesListPage: async (pageToken) => {
            if (pageToken === undefined) {
              return {
                files: [slow, ...failing].map((path) => ({ path, updatedAt: 100 })),
                nextPageToken: 'page-2',
              };
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { files: [{ path: EXTRACTION_PATH, updatedAt: 101 }], nextPageToken: null };
          },
        }),
      ),
    ).rejects.toBe(expired);

    expect(await bodyAt(slow)).toBe(slow);
  });
});

// The delete-all flow's hold (web engine's spec carries the full set): a cycle already
// running is waited out, one asked for meanwhile waits for the work, and a wait given up
// on never runs the work. This engine's cycle lock is its own code, not the platform's.
describe('holding the sync cycles off', () => {
  const EMPTY_PAGE: OpsListReply = {
    ops: [],
    oldestUpdatedAt: 500,
    newestUpdatedAt: 1000,
    hasMore: false,
  };

  it('waits out a running cycle, and reports the wait only then', async () => {
    const onIdleWait = jest.fn();
    await holdSyncCycles(USER, async () => undefined, { onWait: onIdleWait });
    expect(onIdleWait).not.toHaveBeenCalled();

    const order: string[] = [];
    let release!: (reply: OpsListReply) => void;
    const blockedList = new Promise<OpsListReply>((resolve) => {
      release = resolve;
    });
    const cycle = runIncrementalSync(deps({ opsList: () => blockedList }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const onWait = jest.fn();
    const held = holdSyncCycles(
      USER,
      async () => {
        order.push('work');
      },
      { onWait },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onWait).toHaveBeenCalledTimes(1);
    expect(order).toEqual([]);
    order.push('cycle released');
    release(EMPTY_PAGE);
    await Promise.all([cycle, held]);
    expect(order).toEqual(['cycle released', 'work']);
  });

  it('keeps a cycle asked for meanwhile waiting until the work settles', async () => {
    const order: string[] = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const working = new Promise<void>((resolve) => (started = resolve));
    const held = holdSyncCycles(USER, async () => {
      started();
      await released;
      order.push('work done');
    });
    await working;

    const cycle = runIncrementalSync(
      deps({
        opsList: () => {
          order.push('cycle listed');
          return EMPTY_PAGE;
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const listedMeanwhile = [...order];
    release();
    await Promise.all([held, cycle]);

    expect(listedMeanwhile).toEqual([]);
    expect(order).toEqual(['work done', 'cycle listed']);
  });

  // A waiter that gave up passes its turn on: the work never runs, and the cycles
  // behind it are not stuck waiting for it.
  it('never runs the work when the wait is aborted, and lets the next cycle through', async () => {
    let release!: (reply: OpsListReply) => void;
    const blockedList = new Promise<OpsListReply>((resolve) => {
      release = resolve;
    });
    const cycle = runIncrementalSync(deps({ opsList: () => blockedList }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const watchdog = new AbortController();
    const work = jest.fn(async () => undefined);
    const held = holdSyncCycles(USER, work, { signal: watchdog.signal });

    watchdog.abort(new Error('too slow'));
    await expect(held).rejects.toThrow('too slow');
    release(EMPTY_PAGE);
    await cycle;

    await expect(runIncrementalSync(deps({ opsList: () => EMPTY_PAGE }))).resolves.toBeDefined();
    expect(work).not.toHaveBeenCalled();
  });
});

// --- the content push: row, disk, and the two crypto paths -------------------

describe('a content push', () => {
  it('encrypts the plaintext from disk and uploads it without a temp left behind', async () => {
    await seedQueuedContent(FILE_ID, 'image bytes');
    seedQueued(LINK_PATH, 'the link');

    await runIncrementalSync(deps({ commitUpdatedAt: 7777 }));

    // The content blob rode the native path-to-path pipeline; the entity blob
    // rode the in-memory one. Neither crossed over.
    expect(uploadedFiles.get(FILE_PATH)).toBe('enc:image bytes');
    expect(mockPutBlob).toHaveBeenCalledWith(
      urlFor(LINK_PATH),
      new Uint8Array([0xee, ...utf8('the link')]),
      tokenFor(LINK_PATH),
    );
    expect(mockPutBlob.mock.calls.map(([url]) => url)).not.toContain(urlFor(FILE_PATH));
    // Both pipelines carry the blob route's token, the native one included.
    expect(mockPutBlobFromFile).toHaveBeenCalledWith(
      urlFor(FILE_PATH),
      expect.anything(),
      tokenFor(FILE_PATH),
    );
    expect(signVias.every((via) => via === 'api')).toBe(true);

    expect(await pendingPaths()).toEqual([]);
    expect((await getItem(FILE_PATH))?.updatedAt).toBe(7777);
    // The plaintext is the local copy, untouched by the upload, and still claimed.
    expect(plaintextAt(FILE_PATH)).toBe('image bytes');
    expect((await getItem(FILE_PATH))?.hasDataFile).toBeTruthy();
    expect(tempFiles()).toEqual([]);
  });

  it('deletes the temp ciphertext when the upload fails, and keeps the plaintext queued', async () => {
    await seedQueuedContent(FILE_ID, 'image bytes');
    failUploadsFor(FILE_PATH);

    await expect(runIncrementalSync(deps())).rejects.toBe(EXPIRED_URL);

    // The retry next cycle needs exactly this state: the op queued, its payload
    // on disk, and nothing accumulating in the cache dir per attempt.
    expect(await pendingPaths()).toEqual([FILE_PATH]);
    expect(plaintextAt(FILE_PATH)).toBe('image bytes');
    expect(committedPaths()).toEqual([]);
    expect(tempFiles()).toEqual([]);
  });

  // The engine's own retry of a 5xx (@stxapps/shared sync/blob-transfer.ts) — the
  // drift guard for this copy of it, on the transport only expo has: the second
  // attempt must find the sealed temp file the first one sent, and the temp must
  // still go once it lands.
  it('tries a refused upload again from the same sealed file, and still clears the temp', async () => {
    await seedQueuedContent(FILE_ID, 'image bytes');
    let refusals = 1;
    mockPutBlobFromFile.mockImplementation(async (url: string, file: { uri: string }) => {
      if (refusals-- > 0) throw new BlobRequestError('PUT', 500);
      uploaded.add(pathFor(url));
      uploadedFiles.set(pathFor(url), readFileText(file.uri));
      return receiptFor(pathFor(url));
    });

    expect(await settleSkippingBackoff(() => runIncrementalSync(deps()))).not.toBeInstanceOf(Error);

    expect(mockPutBlobFromFile).toHaveBeenCalledTimes(2);
    expect(uploadedFiles.get(FILE_PATH)).toBe('enc:image bytes');
    expect(committedPaths()).toEqual([FILE_PATH]);
    expect(await pendingPaths()).toEqual([]);
    expect(tempFiles()).toEqual([]);
  });

  it('drops a content op whose plaintext file is gone', async () => {
    await seedQueuedContent(FILE_ID, 'image bytes');
    dataFileFor(FILE_PATH).delete();

    await runIncrementalSync(deps());

    // TERMINAL, not transient: nothing will put those bytes back, so retrying it
    // forever is a queue no cycle can drain. Never committed — an op logged for
    // an object we didn't upload would 404 every other device's puller.
    expect(await pendingPaths()).toEqual([]);
    expect(mockPutBlobFromFile).not.toHaveBeenCalled();
    expect(committedPaths()).toEqual([]);
  });

  it('drops a content op whose row no longer claims a plaintext file', async () => {
    // The other half of the two-part payload test. The file is on disk, but the
    // row's claim over it is gone — the state a re-stored row leaves behind, and
    // the bytes under it are the OLD version, so uploading them would publish
    // stale content under a fresh commit.
    await seedQueuedContent(FILE_ID, 'image bytes');
    await markItemDataFile(FILE_PATH, false);

    await runIncrementalSync(deps());

    expect(await pendingPaths()).toEqual([]);
    expect(mockPutBlobFromFile).not.toHaveBeenCalled();
    expect(committedPaths()).toEqual([]);
  });

  it('commits content before the metadata that references it', async () => {
    await seedQueuedContent(FILE_ID, 'image bytes');
    seedQueued(EXTRACTION_PATH, 'refers to the image');

    await runIncrementalSync(deps());

    // Separate commit calls, content's first — so no crash mid-push can leave
    // metadata pointing at an object that was never uploaded.
    expect(commits.map((batch) => batch.map((o) => o.path))).toEqual([
      [FILE_PATH],
      [EXTRACTION_PATH],
    ]);
  });

  // Drift guard for web's receipt case: both of this engine's uploads — the
  // native file PUT and the in-memory entity PUT — hand their receipt to the
  // chunk's commit (docs/local-first-sync.md, _upload receipts_).
  it('commits each put with the receipt its PUT answered with', async () => {
    await seedQueuedContent(FILE_ID, 'image bytes');
    seedQueued(EXTRACTION_PATH, 'refers to the image');

    await runIncrementalSync(deps());

    expect(commits).toEqual([
      [{ op: 'put', path: FILE_PATH, receipt: receiptFor(FILE_PATH) }],
      [{ op: 'put', path: EXTRACTION_PATH, receipt: receiptFor(EXTRACTION_PATH) }],
    ]);
  });

  it('holds the metadata phase when a content upload failed', async () => {
    await seedQueuedContent(FILE_ID, 'image bytes');
    seedQueued(EXTRACTION_PATH, 'refers to the image');
    failUploadsFor(FILE_PATH);

    await expect(runIncrementalSync(deps())).rejects.toBe(EXPIRED_URL);

    expect(mockPutBlob.mock.calls.map(([url]) => url)).not.toContain(urlFor(EXTRACTION_PATH));
    expect(committedPaths()).toEqual([]);
    expect(await pendingPaths()).toEqual([EXTRACTION_PATH, FILE_PATH]);
  });

  // Drift guards for web's 'the put chunk' cases, which carry the reasoning: this
  // copy's chunk sizes, its gate short-circuit and its metadata hold are its own
  // source.
  describe('the put chunk', () => {
    const COUNT = 150; // more than a content chunk holds, less than an index one
    const isContent = (batch: { path: string }[]) => batch[0].path.startsWith(FILES_PREFIX);

    beforeEach(async () => {
      for (let i = 0; i < COUNT; i++) {
        await seedQueuedContent(`f_${i}`, 'image bytes');
        seedQueued(pathFromId(`l_${i}`, LINKS_PREFIX), 'a link');
      }
    });

    it('commits content in smaller chunks than the index', async () => {
      await runIncrementalSync(deps());

      expect(commits.filter((b) => !isContent(b))).toHaveLength(1);
      expect(commits.filter(isContent).length).toBeGreaterThan(1);
      expect(commits.at(-1)?.every((o) => !o.path.startsWith(FILES_PREFIX))).toBe(true);
      expect(await pendingPaths()).toEqual([]);
    });

    it('starts the next chunk’s PUTs while the last chunk’s slowest is still out', async () => {
      // Held until a PUT of the second chunk goes out, or by a timer that fails
      // the case if none ever does.
      const batches: string[][] = [];
      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      let releasedBy: 'next chunk' | 'timer' | undefined;
      mockPutBlobFromFile.mockImplementation(async (url: string) => {
        const path = pathFor(url);
        if (path === batches[0][0]) {
          const timer = setTimeout(() => {
            releasedBy ??= 'timer';
            release();
          }, 2_000);
          await held;
          clearTimeout(timer);
        } else if (batches[1]?.includes(path)) {
          releasedBy ??= 'next chunk';
          release();
        }
        uploaded.add(path);
        return receiptFor(path);
      });

      await runIncrementalSync(
        deps({
          filesSign: (paths, op) => {
            if (op === 'put') batches.push(paths);
          },
        }),
      );

      expect(releasedBy).toBe('next chunk');
      expect(await pendingPaths()).toEqual([]);
    });

    it('asks the quota gate once, and holds the metadata behind refused content', async () => {
      // The gate refuses content and would grant the metadata after it — the
      // window a delete or a purchase elsewhere opens between the two calls.
      let putSigns = 0;
      const outcome = await runIncrementalSync(
        deps({
          opsList: () => ({ ops: [], oldestUpdatedAt: 500, newestUpdatedAt: 1500, hasMore: false }),
          filesSign: (paths, op) => {
            if (op !== 'put') return;
            putSigns += 1;
            if (paths[0].startsWith(FILES_PREFIX)) {
              throw new ApiError(403, JSON.stringify({ error: 'quota_exceeded' }));
            }
          },
        }),
      );

      expect(putSigns).toBe(1);
      expect(commits).toEqual([]);
      expect(outcome.blockedCount).toBe(2 * COUNT);
      expect(await pendingPaths()).toHaveLength(2 * COUNT);
    });
  });
});

// Drift guard for the cycle counter (web's engine.spec.ts, _the cycle counter_, is
// canonical): the push ticks per transfer — here through BOTH pipelines, the
// native file one included — and so has moved before the queue does.
describe('the cycle counter', () => {
  it('counts each transfer as it settles, ahead of the commit that drains the queue', async () => {
    await seedQueuedContent(FILE_ID, 'image bytes');
    seedQueued(LINK_PATH, 'the link');
    const ticks: [string, number, number][] = [];
    const atCommits: number[] = [];

    await runIncrementalSync(
      deps({ opsCommit: () => void atCommits.push(ticks.at(-1)?.[1] ?? 0) }),
      (step, done, total) => ticks.push([step, done, total]),
    );

    expect(ticks[0]).toEqual(['upload', 0, 2]);
    expect(ticks.at(-1)).toEqual(['upload', 2, 2]);
    // The content phase's commit, then the metadata phase's: each one's transfer
    // had already ticked.
    expect(atCommits).toEqual([1, 2]);
  });
});

// --- the pull: the row and the file must move together -----------------------

describe('a pull that re-stores a content record', () => {
  const serverPut = (path: string, updatedAt: number) => () => ({
    ops: [{ op: 'put' as const, path, updatedAt }],
    oldestUpdatedAt: 500,
    newestUpdatedAt: updatedAt,
    hasMore: false,
  });

  it('tears down the stale plaintext so the next read re-materializes', async () => {
    await seedSyncedContent(FILE_PATH, 'the old image', 1500);

    await runIncrementalSync(deps({ opsList: serverPut(FILE_PATH, 2000) }));

    // The row moved, so the file under it is a lie now. Both halves of the
    // "not downloaded" state, together: no claim, no file.
    expect((await getItem(FILE_PATH))?.updatedAt).toBe(2000);
    expect((await getItem(FILE_PATH))?.hasDataFile).toBeFalsy();
    expect(plaintextAt(FILE_PATH)).toBeUndefined();
    // Content is never fetched eagerly — only its row is.
    expect(mockGetBlobToFile).not.toHaveBeenCalled();
  });

  it('keeps the plaintext of a path this device re-wrote mid-cycle', async () => {
    await seedSyncedContent(FILE_PATH, 'the old image', 1500);

    await runIncrementalSync(
      deps({
        opsList: async () => {
          // The user replaces the image while the cycle is listing: local-only,
          // absent from the pending snapshot the reconcile filtered against.
          await seedQueuedContent(FILE_ID, 'the new image');
          return serverPut(FILE_PATH, 2000)();
        },
      }),
    );

    // The guard spared the ROW, so the file must be spared with it — it is the
    // queued op's upload payload, and deleting it would strand the write with no
    // error, no pending count and no retry.
    expect(plaintextAt(FILE_PATH)).toBe('the new image');
    expect(await pendingPaths()).toEqual([FILE_PATH]);

    // And it is not wedged: the next cycle carries it.
    await runIncrementalSync(deps());
    expect(uploadedFiles.get(FILE_PATH)).toBe('enc:the new image');
    expect(await pendingPaths()).toEqual([]);
  });
});

describe('a delete the pull applied', () => {
  const serverDelete = (path: string) => () => ({
    ops: [{ op: 'delete' as const, path, updatedAt: 2000 }],
    oldestUpdatedAt: 500,
    newestUpdatedAt: 2000,
    hasMore: false,
  });

  it('removes the plaintext of a content path deleted on another device', async () => {
    await seedSyncedContent(FILE_PATH, 'the image', 1500);

    await runIncrementalSync(deps({ opsList: serverDelete(FILE_PATH) }));

    expect(await getItem(FILE_PATH)).toBeUndefined();
    expect(plaintextAt(FILE_PATH)).toBeUndefined();
  });

  it('spares the plaintext of a path re-created mid-cycle', async () => {
    await seedSyncedContent(FILE_PATH, 'the image', 1500);

    await runIncrementalSync(
      deps({
        opsList: async () => {
          await seedQueuedContent(FILE_ID, 'replaced, not deleted');
          return serverDelete(FILE_PATH)();
        },
      }),
    );

    // Local-wins holds even though the server says the path is gone — and the
    // file half follows the row half, not the reconcile's own list.
    expect(await getItem(FILE_PATH)).toBeDefined();
    expect(plaintextAt(FILE_PATH)).toBe('replaced, not deleted');
    expect(await pendingPaths()).toEqual([FILE_PATH]);
  });
});

// --- the lazy materializer ---------------------------------------------------

it('cannot recreate ownership when an old first sync starts after teardown', async () => {
  getDb().delete(syncMeta).run();
  await expect(runInitialSync(deps())).rejects.toThrow(/no longer signed in/);
  expect(getDb().select().from(syncMeta).all()).toHaveLength(0);
});

describe('loadEntityContent', () => {
  beforeEach(() => {
    getDb().transaction((tx) => putItemsTx(tx, [toItemRecord(FILE_PATH, 1000)]));
    r2Content.set(FILE_PATH, 'page copy');
  });

  it('materializes the plaintext, claims it on the row, and cleans up the ciphertext', async () => {
    const file = await loadEntityContent(deps(), FILE_PATH);

    expect(file?.uri).toBe(dataFileFor(FILE_PATH).uri);
    expect(plaintextAt(FILE_PATH)).toBe('page copy');
    expect((await getItem(FILE_PATH))?.hasDataFile).toBeTruthy();
    expect(tempFiles()).toEqual([]);
  });

  it('serves an already-materialized file without a round trip', async () => {
    await seedSyncedContent(FILE_PATH, 'page copy', 1000);

    const file = await loadEntityContent(deps(), FILE_PATH);

    expect(file?.uri).toBe(dataFileFor(FILE_PATH).uri);
    expect(mockGetBlobToFile).not.toHaveBeenCalled();
  });

  it('re-materializes when the row claims a file that is gone from disk', async () => {
    // The claim and the disk are two stores; an OS purge or a half-finished
    // teardown can leave the flag set over nothing, and trusting it alone would
    // hand back a uri that renders as a broken image forever.
    await markItemDataFile(FILE_PATH, true);

    const file = await loadEntityContent(deps(), FILE_PATH);

    expect(mockGetBlobToFile).toHaveBeenCalled();
    expect(file && readFileText(file.uri)).toBe('page copy');
  });

  it('discards the plaintext and reports nothing when the row was restamped mid-fetch', async () => {
    const result = await loadEntityContent(
      deps({
        // A pull lands the newer version while this fetch is being signed.
        filesSign: async () => {
          await stampItemUpdatedAts(USER, [{ path: FILE_PATH, updatedAt: 2000 }]);
        },
      }),
      FILE_PATH,
    );

    // The DIVERGENCE from web, which still returns the bytes it fetched: here the
    // caller is handed a FILE, so returning one that is about to be torn down (or
    // leaving it in place under the new stamp, served as current until the server
    // moves again) is worse than reporting nothing. Losing the race costs the
    // read; the next call fetches the new version.
    expect(result).toBeUndefined();
    expect(plaintextAt(FILE_PATH)).toBeUndefined();
    expect((await getItem(FILE_PATH))?.hasDataFile).toBeFalsy();
    expect(tempFiles()).toEqual([]);
  });

  // The drift guard for the download retry, on expo's to-file transport: the
  // second attempt overwrites what the first left in the temp, and the temp still
  // goes once the plaintext is materialized.
  it('fetches again after a refused download, and still clears the temp', async () => {
    let refusals = 1;
    mockGetBlobToFile.mockImplementation(async (url: string, file: { uri: string }) => {
      if (refusals-- > 0) {
        writeFileText(file.uri, 'half a response');
        throw new BlobRequestError('GET', 500);
      }
      writeFileText(file.uri, `enc:${r2Content.get(pathFor(url))}`);
    });

    const file = await settleSkippingBackoff(() => loadEntityContent(deps(), FILE_PATH));

    expect(mockGetBlobToFile).toHaveBeenCalledTimes(2);
    expect((file as { uri: string } | undefined)?.uri).toBe(dataFileFor(FILE_PATH).uri);
    expect(plaintextAt(FILE_PATH)).toBe('page copy');
    expect(tempFiles()).toEqual([]);
  });

  it('returns undefined and leaves no temp behind when the object is gone server-side', async () => {
    r2Content.clear();

    await expect(loadEntityContent(deps(), FILE_PATH)).resolves.toBeUndefined();
    expect(tempFiles()).toEqual([]);
    expect((await getItem(FILE_PATH))?.hasDataFile).toBeFalsy();
  });
});

describe('loadEntityContents', () => {
  it('materializes what is missing, skips what is resident, and reports what is unknown', async () => {
    getDb().transaction((tx) => putItemsTx(tx, [toItemRecord(FILE_PATH, 1000)]));
    await seedSyncedContent(OTHER_FILE_PATH, 'already here', 1000);
    r2Content.set(FILE_PATH, 'fetched');

    const ticks: [number, number][] = [];
    const { missingPaths } = await loadEntityContents(
      deps(),
      [FILE_PATH, OTHER_FILE_PATH, 'files/gone.enc'],
      (done, total) => ticks.push([done, total]),
    );

    expect(missingPaths).toEqual(['files/gone.enc']);
    expect(plaintextAt(FILE_PATH)).toBe('fetched');
    expect(plaintextAt(OTHER_FILE_PATH)).toBe('already here');
    // The resident path and the unknown one cost no round trip, so neither
    // inflates the denominator.
    expect(ticks).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(tempFiles()).toEqual([]);
  });

  it('does not report a restamped path as missing, but discards its stale plaintext', async () => {
    getDb().transaction((tx) => putItemsTx(tx, [toItemRecord(FILE_PATH, 1000)]));
    r2Content.set(FILE_PATH, 'fetched');

    const { missingPaths } = await loadEntityContents(
      deps({
        filesSign: async () => {
          await stampItemUpdatedAts(USER, [{ path: FILE_PATH, updatedAt: 2000 }]);
        },
      }),
      [FILE_PATH],
    );

    // A CAS-miss and a 404 look alike and are not: the blob EXISTS, the row just
    // moved. Reporting it missing would tell the export flow a file is gone when
    // the caller only needs to re-read the store.
    expect(missingPaths).toEqual([]);
    expect(plaintextAt(FILE_PATH)).toBeUndefined();
    expect(tempFiles()).toEqual([]);
  });

  // Web engine's spec carries the reasoning: rejected, one bad blob failed the whole
  // batch on every attempt — the export never finished.
  it('reports a blob that does not open under its path as missing, and lands the rest', async () => {
    getDb().transaction((tx) =>
      putItemsTx(tx, [toItemRecord(FILE_PATH, 1000), toItemRecord(OTHER_FILE_PATH, 1000)]),
    );
    r2Content.set(OTHER_FILE_PATH, 'fetched');
    mockGetBlobToFile.mockImplementation(async (url: string, file: { uri: string }) => {
      const path = pathFor(url);
      writeFileText(
        file.uri,
        path === FILE_PATH ? 'not a sealed frame' : `enc:${r2Content.get(path)}`,
      );
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    let missingPaths: string[];
    try {
      ({ missingPaths } = await loadEntityContents(deps(), [FILE_PATH, OTHER_FILE_PATH]));
    } finally {
      warn.mockRestore();
    }

    expect(missingPaths).toEqual([FILE_PATH]);
    expect(plaintextAt(FILE_PATH)).toBeUndefined();
    expect((await getItem(FILE_PATH))?.hasDataFile).toBeFalsy();
    expect(plaintextAt(OTHER_FILE_PATH)).toBe('fetched');
    expect(tempFiles()).toEqual([]);
  });

  // The drift guard for web's best-effort mode (its spec has the cases and the
  // reasoning): the export's file phase, offline, used to fail the whole backup.
  it('best-effort, fails a path on a transport error and lands the rest', async () => {
    getDb().transaction((tx) =>
      putItemsTx(tx, [toItemRecord(FILE_PATH, 1000), toItemRecord(OTHER_FILE_PATH, 1000)]),
    );
    r2Content.set(OTHER_FILE_PATH, 'fetched');
    mockGetBlobToFile.mockImplementation(async (url: string, file: { uri: string }) => {
      const path = pathFor(url);
      if (path === FILE_PATH) throw new BlobRequestError('GET', 503);
      writeFileText(file.uri, `enc:${r2Content.get(path)}`);
    });

    // A 503 every time: the retry's three tries all fail, and only then the path.
    const result = await settleSkippingBackoff(() =>
      loadEntityContents(deps(), [FILE_PATH, OTHER_FILE_PATH], undefined, { bestEffort: true }),
    );

    expect(result).toEqual({ missingPaths: [], failedPaths: [FILE_PATH] });
    expect(plaintextAt(FILE_PATH)).toBeUndefined();
    expect((await getItem(FILE_PATH))?.hasDataFile).toBeFalsy();
    expect(plaintextAt(OTHER_FILE_PATH)).toBe('fetched');
    expect(tempFiles()).toEqual([]);
  });
});

// --- the path each blob is bound to ----------------------------------------------

// A blob opens only under the sync path it was sealed for (shared
// crypto/blob-aad.ts), and that holds for the native file framer too. The crypto
// is a stand-in in this file, so what is pinned here is the engine's half: every
// seal names the path the blob is PUT to, and every open the path it was fetched
// from — never a local file path. A wrong path is not caught by any round trip
// here (the stand-in ignores it), and on a device it fails every download of that
// blob, on every other client.
describe('the path each blob is sealed for and opened under', () => {
  const pathArg = (mock: unknown, index: number) =>
    (mock as jest.Mock).mock.calls.map((call) => call[index]);

  it('seals a pushed entity and a pushed file for the paths they are PUT to', async () => {
    seedQueued(LINK_PATH, 'the link');
    await seedQueuedContent(FILE_ID, 'image bytes');

    await runIncrementalSync(deps());

    expect(pathArg(encryptEntity, 2)).toEqual([LINK_PATH]);
    expect(pathArg(encryptFile, 3)).toEqual([FILE_PATH]);
  });

  it('opens a pulled entity under the path it was listed at, each entry of a page under its own', async () => {
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('the server copy')]));

    await runIncrementalSync(
      deps({
        opsList: () => ({
          // Two entries, so opening every one under a sibling's path would show.
          ops: [
            { op: 'put', path: LINK_PATH, updatedAt: 2000 },
            { op: 'put', path: OTHER_LINK_PATH, updatedAt: 2001 },
          ],
          oldestUpdatedAt: 500,
          newestUpdatedAt: 2001,
          hasMore: false,
        }),
      }),
    );

    expect(pathArg(decryptEntity, 2).sort()).toEqual([LINK_PATH, OTHER_LINK_PATH]);
  });

  it('opens fetched content under its own path, one at a time and in a batch', async () => {
    getDb().transaction((tx) =>
      putItemsTx(tx, [toItemRecord(FILE_PATH, 1000), toItemRecord(OTHER_FILE_PATH, 1000)]),
    );
    r2Content.set(FILE_PATH, 'one');
    r2Content.set(OTHER_FILE_PATH, 'other');

    await loadEntityContent(deps(), FILE_PATH);
    await loadEntityContents(deps(), [OTHER_FILE_PATH]);

    expect(pathArg(decryptFile, 3)).toEqual([FILE_PATH, OTHER_FILE_PATH]);
  });
});

// One pulled blob that does not open under its path is skipped, not a failed cycle
// (web engine's spec carries the reasoning and the full set); an unknown version still
// fails it.
describe('a pulled blob that does not open under its path', () => {
  const TWO_PUTS: OpsListReply = {
    ops: [
      { op: 'put', path: LINK_PATH, updatedAt: 2000 },
      { op: 'put', path: OTHER_LINK_PATH, updatedAt: 2001 },
    ],
    oldestUpdatedAt: 500,
    newestUpdatedAt: 2001,
    hasMore: false,
  };

  beforeEach(() => {
    mockGetBlob.mockImplementation(async (url: string) =>
      Promise.resolve(new Uint8Array([0xee, ...utf8(`server ${pathFor(url)}`)])),
    );
  });
  // clearAllMocks keeps implementations, and every later case expects the stand-in's.
  afterEach(() => {
    mockGetBlob.mockReset();
    (decryptEntity as jest.Mock).mockImplementation(async (_key: unknown, bytes: Uint8Array) =>
      bytes.slice(1),
    );
  });

  function failToOpen(path: string, error: Error): void {
    (decryptEntity as jest.Mock).mockImplementation(
      async (_key: unknown, bytes: Uint8Array, at: string) => {
        if (at === path) throw error;
        return bytes.slice(1);
      },
    );
  }

  it('is skipped, and the rest of the pull lands and moves the cursor', async () => {
    seedSynced(LINK_PATH, 'held here', 1000);
    failToOpen(LINK_PATH, new BlobUnreadableError(LINK_PATH));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await runIncrementalSync(deps({ opsList: () => TWO_PUTS }));
    } finally {
      warn.mockRestore();
    }

    expect(await bodyAt(LINK_PATH)).toBe('held here');
    expect(await bodyAt(OTHER_LINK_PATH)).toBe(`server ${OTHER_LINK_PATH}`);
    expect((await getSyncMeta(USER))?.syncCursorUpdatedAt).toBe(2001);
  });

  it('still fails the cycle on an unknown version', async () => {
    failToOpen(LINK_PATH, new Error('Unknown blob format version: 2'));

    await expect(runIncrementalSync(deps({ opsList: () => TWO_PUTS }))).rejects.toThrow(
      'Unknown blob format version: 2',
    );

    expect((await getSyncMeta(USER))?.syncCursorUpdatedAt).toBe(1000);
  });
});

// A link that names one tag twice. The schema reads `tagIds` as a plain array, and
// web's multiEntry index folds the repeat away without a word, so web writes and
// reads such a link fine. Here each tag is a junction row keyed `(path, tagId)`: the
// repeat met its own primary key and the store refused the whole write. That failed
// the pull on the one link, on every retry — a first sync whose gate never cleared on
// this device, or a cycle that never moved its cursor again, while every web client
// read the same library without a fault.
describe('a pulled link that names a tag twice', () => {
  const TWICE = JSON.stringify({
    url: 'https://example.com/a',
    listId: 'l_list',
    tagIds: ['t_a', 't_b', 't_a'],
    createdAt: 1,
    updatedAt: 1,
  });

  afterEach(() => mockGetBlob.mockReset());

  it('lands with the tag once, and the first sync completes', async () => {
    getDb().delete(syncMeta).run();
    await beginInitialSync(USER);
    mockGetBlob.mockImplementation(async (url: string) =>
      Promise.resolve(
        new Uint8Array([0xee, ...utf8(pathFor(url) === LINK_PATH ? TWICE : 'the server copy')]),
      ),
    );

    await runInitialSync(
      deps({
        filesList: () => [
          { path: LINK_PATH, updatedAt: 5000 },
          { path: OTHER_LINK_PATH, updatedAt: 5001 },
        ],
        opsList: () => ({ ops: [], oldestUpdatedAt: 2000, newestUpdatedAt: 6000, hasMore: false }),
      }),
    );

    expect(await isFirstSyncDone(USER)).toBe(true);
    expect(await bodyAt(LINK_PATH)).toBe(TWICE);
    expect(await bodyAt(OTHER_LINK_PATH)).toBe('the server copy');
    const tags = getDb()
      .select({ tagId: itemTagIds.tagId })
      .from(itemTagIds)
      .where(eq(itemTagIds.path, LINK_PATH))
      .all()
      .map((row) => row.tagId)
      .sort();
    expect(tags).toEqual(['t_a', 't_b']);
  });
});

// --- drift guards ------------------------------------------------------------

// The cases below are covered end-to-end on web. They are restated here at one
// case each because the two engines are duplicated SOURCE: edit this copy's
// phase order, self-heal, quota branch, cursor writes or upload-time check and
// nothing else in the workspace fails.
describe('the cycle, against this copy of it', () => {
  it('does not delete a create that landed mid-cycle, and syncs it next cycle', async () => {
    seedQueued(LINK_PATH, 'the link');

    // Empty op log under a returning client → fallback. The extraction lands
    // while the full listing is in flight — after the pending snapshot, before
    // the local-delete reconcile.
    await runIncrementalSync(
      deps({
        filesList: async () => {
          await writeExtraction(USER, 'l_a', { fields: { title: 'Google' } });
          return [];
        },
      }),
    );

    expect(await getItem(EXTRACTION_PATH)).toBeDefined();
    expect(await pendingPaths()).toEqual([EXTRACTION_PATH]); // the link's op drained
    expect(committedPaths()).toEqual([LINK_PATH]);

    commits = [];
    await runIncrementalSync(deps());
    expect(committedPaths()).toEqual([EXTRACTION_PATH]);
    expect(await pendingPaths()).toEqual([]);
  });

  it('drops a pending put whose record is gone and re-downloads the server copy', async () => {
    // The wedged state: an op that can never be satisfied (nothing will put those
    // bytes back), whose path the reconcile then reserves for a push that never
    // happens — so the heal has to put the path back into the download set.
    getDb().transaction((tx) => enqueuePutTx(tx, USER, LINK_PATH, 0));
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('the server copy')]));

    await runIncrementalSync(
      deps({
        opsList: () => ({
          ops: [{ op: 'put', path: LINK_PATH, updatedAt: 2000 }],
          oldestUpdatedAt: 500,
          newestUpdatedAt: 2000,
          hasMore: false,
        }),
      }),
    );

    expect(await pendingPaths()).toEqual([]);
    expect(await bodyAt(LINK_PATH)).toBe('the server copy');
    expect((await getItem(LINK_PATH))?.updatedAt).toBe(2000);
    expect(committedPaths()).toEqual([]);
  });

  it('records a refused push and completes, still committing the deletes', async () => {
    // docs/iap.md promises an over-quota account "read-only-plus-delete, never
    // data loss": the put is refused, the cycle does NOT throw, the queued data
    // stays queued, and the deletes — which never reach files/sign — still get
    // through, which is what lets the user free space.
    seedSynced(LINK_PATH, 'trashed locally', 1500);
    seedQueued(LINK_PATH, 'trashed locally', 1500);
    getDb().transaction((tx) => enqueueDeleteTx(tx, USER, OTHER_LINK_PATH, 1500));

    const outcome = await runIncrementalSync(
      deps({
        opsList: () => ({
          ops: [],
          oldestUpdatedAt: 500,
          newestUpdatedAt: 1500,
          hasMore: false,
        }),
        filesSign: (_paths, op) => {
          if (op === 'put') throw new ApiError(403, JSON.stringify({ error: 'quota_exceeded' }));
        },
      }),
    );

    expect(outcome.blocked).toBe(true);
    expect(outcome.blockedCount).toBe(1);
    expect(committedPaths()).toEqual([OTHER_LINK_PATH]);
    expect(await pendingPaths()).toEqual([LINK_PATH]);
    expect(await bodyAt(LINK_PATH)).toBe('trashed locally');
  });

  it('leaves the cursor where its listing ended, not on its own commit', async () => {
    // This copy folded its commits into the cursor too. The clamp stamps a commit
    // above an op another client committed a moment before, so a cursor at our own
    // stamp sits past an op nobody read — a link saved on the laptop that never
    // reaches this phone, with nothing queued and nothing to retry.
    seedQueued(LINK_PATH, 'the link');

    await runIncrementalSync(
      deps({
        opsList: () => ({ ops: [], oldestUpdatedAt: 500, newestUpdatedAt: 1500, hasMore: false }),
        commitUpdatedAt: 9000,
      }),
    );

    // It did commit, and stamped the record — the stamp just went no further.
    expect(committedPaths()).toEqual([LINK_PATH]);
    expect((await getItem(LINK_PATH))?.updatedAt).toBe(9000);
    expect(await getSyncMeta(USER)).toMatchObject({
      syncCursorUpdatedAt: 1000,
      syncCursorPath: 'links/l_seed.enc',
    });
  });

  it('pages the op log by keyset, and ends its cursor on the last op of the last page', async () => {
    // "The last op this cycle listed" is computed in this copy's own loop: each
    // page is asked for from the last op of the one before — both halves of the
    // key — and the cursor ends where the last page did. Get it wrong and a phone
    // that was offline for a month skips a page of ops, or asks for the same page
    // until the cycle dies.
    mockGetBlob.mockImplementation(
      async (url: string) => new Uint8Array([0xee, ...utf8(pathFor(url))]),
    );
    const pages: OpsListReply[] = [
      {
        ops: [{ op: 'put', path: LINK_PATH, updatedAt: 2000 }],
        oldestUpdatedAt: 500,
        newestUpdatedAt: 3000,
        hasMore: true,
      },
      {
        ops: [{ op: 'put', path: OTHER_LINK_PATH, updatedAt: 3000 }],
        oldestUpdatedAt: 500,
        newestUpdatedAt: 3000,
        hasMore: false,
      },
    ];
    const asked: { since?: number; sincePath?: string }[] = [];

    await runIncrementalSync(
      deps({
        opsList: (from) => {
          asked.push(from);
          return pages[asked.length - 1];
        },
      }),
    );

    expect(asked).toEqual([
      { since: 1000, sincePath: 'links/l_seed.enc' },
      { since: 2000, sincePath: LINK_PATH },
    ]);
    expect(await bodyAt(LINK_PATH)).toBe(LINK_PATH);
    expect(await bodyAt(OTHER_LINK_PATH)).toBe(OTHER_LINK_PATH);
    expect(await getSyncMeta(USER)).toMatchObject({
      syncCursorUpdatedAt: 3000,
      syncCursorPath: OTHER_LINK_PATH,
    });
  });

  it('ends a listing-built cursor on the log’s high-water mark, not the listing’s newest stamp', async () => {
    // Both listing flows, since both are this copy's own code. A paged listing is
    // not a snapshot, so the newest stamp it shows (5000 here) says nothing about
    // an object written into a range it had already passed; the log's newest
    // stamp, read before the listing, is the one that can be claimed.
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('the server copy')]));
    const listing = () => [{ path: LINK_PATH, updatedAt: 5000 }];

    // A fallback: the log's retained range starts past this device's cursor.
    await runIncrementalSync(
      deps({
        filesList: listing,
        opsList: () => ({ ops: [], oldestUpdatedAt: 2000, newestUpdatedAt: 3000, hasMore: false }),
      }),
    );
    // The listing was reconciled — the cursor just isn't taken from it.
    expect(await bodyAt(LINK_PATH)).toBe('the server copy');
    expect(await getSyncMeta(USER)).toMatchObject({
      syncCursorUpdatedAt: 3000,
      syncCursorPath: '',
    });

    // A first sync, on a device that has not finished one.
    getDb().delete(syncMeta).run();
    await beginInitialSync(USER);
    await runInitialSync(
      deps({
        filesList: listing,
        opsList: () => ({ ops: [], oldestUpdatedAt: 2000, newestUpdatedAt: 4000, hasMore: false }),
      }),
    );
    expect(await getSyncMeta(USER)).toMatchObject({
      syncCursorUpdatedAt: 4000,
      syncCursorPath: '',
    });
  });

  it('drops, on a first sync’s retry, what the attempt before it stored and the listing no longer shows', async () => {
    // A first sync only ever added: it assumed the empty store of a fresh
    // sign-in. A pull that died partway left what it had stored, and its retry
    // lists a namespace another device may have deleted from since — and that
    // delete was committed before the retry read the log's high-water mark, so it
    // is at or below the cursor the retry ends on and no later pull brings it.
    // One leftover is a `files/` row, because here dropping it is two writes.
    getDb().delete(syncMeta).run();
    await beginInitialSync(USER);
    seedSynced(OTHER_LINK_PATH, 'deleted since', 100);
    await seedSyncedContent(OTHER_FILE_PATH, 'its image', 100);
    // Saved on this device before the retry got there: local only too, but queued.
    seedQueued(EXTRACTION_PATH, 'not pushed yet');
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('the server copy')]));

    await runInitialSync(
      deps({
        filesList: () => [{ path: LINK_PATH, updatedAt: 5000 }],
        opsList: () => ({ ops: [], oldestUpdatedAt: 2000, newestUpdatedAt: 6000, hasMore: false }),
      }),
    );

    expect(await getItem(OTHER_LINK_PATH)).toBeUndefined();
    expect(await getItem(OTHER_FILE_PATH)).toBeUndefined();
    expect(plaintextAt(OTHER_FILE_PATH)).toBeUndefined();
    // The controls: what the listing shows was stored, and what is queued here was
    // left for the push.
    expect(await bodyAt(LINK_PATH)).toBe('the server copy');
    expect(await bodyAt(EXTRACTION_PATH)).toBe('not pushed yet');
    expect(await pendingPaths()).toEqual([EXTRACTION_PATH]);
  });

  it('runs no cycle while the first sync is still pulling, so a link saved meanwhile is not dropped', async () => {
    // A share lands during a long first pull and kicks a cycle, as any local
    // write does. Run beside the pull, that cycle pushed the link and cleared its
    // op — and the pull, reconciling against a listing taken before the push, then
    // dropped a path that was local-only and no longer queued. Web's engine holds
    // its cycle lock across the pull; this one's pull takes no lock, so the cycle
    // declines.
    getDb().delete(syncMeta).run();
    await beginInitialSync(USER);
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('the server copy')]));
    const listing = () => [{ path: LINK_PATH, updatedAt: 5000 }];
    const opsList = () => ({
      ops: [],
      oldestUpdatedAt: 2000,
      newestUpdatedAt: 6000,
      hasMore: false,
    });

    // The pull, held at its first download so the cycle below runs inside it.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const pull = runInitialSync(
      deps({
        filesList: listing,
        opsList,
        filesSign: async (_paths, op) => {
          if (op === 'get') await held;
        },
      }),
    );

    seedQueued(OTHER_LINK_PATH, 'shared mid-pull');
    await runIncrementalSync(deps({ filesList: listing, opsList }));
    expect(commits).toEqual([]);

    release();
    await pull;
    expect(await bodyAt(OTHER_LINK_PATH)).toBe('shared mid-pull');
    expect(await pendingPaths()).toEqual([OTHER_LINK_PATH]);

    // The control: the cycle that follows the pull is the one that pushes it.
    await runIncrementalSync(deps({ filesList: listing, opsList }));
    expect(committedPaths()).toEqual([OTHER_LINK_PATH]);
    expect(await pendingPaths()).toEqual([]);
    expect(await bodyAt(OTHER_LINK_PATH)).toBe('shared mid-pull');
  });

  it('joins a first sync already in flight, and pulls nothing once the flag is set', async () => {
    // What the case above rests on. A cycle declines by reading the flag, so the
    // two stay apart only while every pull began with the flag unset and is the
    // only one running — and a provider effect that re-ran over a pull in flight
    // could start a second beside it. Whichever finished first set the flag with
    // the other still reconciling, and a cycle was then free to run beside that
    // one. Web's pull gets both halves from its cycle lock; this one has a slot.
    getDb().delete(syncMeta).run();
    await beginInitialSync(USER);
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('the server copy')]));
    let listings = 0;
    const listing = () => {
      listings += 1;
      return [{ path: LINK_PATH, updatedAt: 5000 }];
    };
    const opsList = () => ({
      ops: [],
      oldestUpdatedAt: 2000,
      newestUpdatedAt: 6000,
      hasMore: false,
    });

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = runInitialSync(
      deps({
        filesList: listing,
        opsList,
        filesSign: async (_paths, op) => {
          if (op === 'get') await held;
        },
      }),
    );
    // The second caller is the gate still on screen, so the count is its to show.
    const joinedTicks: [number, number][] = [];
    const second = runInitialSync(deps({ filesList: listing, opsList }), (done, total) =>
      joinedTicks.push([done, total]),
    );

    release();
    await Promise.all([first, second]);
    expect(listings).toBe(1);
    expect(joinedTicks).toContainEqual([1, 1]);
    expect(await bodyAt(LINK_PATH)).toBe('the server copy');

    // A pull asked for after that one finished: its caller read the flag before
    // its wait for the claim, and the flag has been set since.
    await runInitialSync(deps({ filesList: listing, opsList }));
    expect(listings).toBe(1);
    expect(await getSyncMeta(USER)).toMatchObject({
      syncCursorUpdatedAt: 6000,
      syncCursorPath: '',
    });
  });

  it('frees the slot when a first sync fails, so the retry is a pull of its own', async () => {
    // The other edge of the slot: one that outlived a failed pull would hand its
    // rejection to every retry, and the gate's "Try again" could never succeed.
    getDb().delete(syncMeta).run();
    await beginInitialSync(USER);
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('the server copy')]));

    await expect(
      runInitialSync(
        deps({
          filesList: () => {
            throw new ApiError(400, JSON.stringify({ error: 'bad_request' }));
          },
        }),
      ),
    ).rejects.toThrow();
    expect(await getItem(LINK_PATH)).toBeUndefined();

    await runInitialSync(deps({ filesList: () => [{ path: LINK_PATH, updatedAt: 5000 }] }));
    expect(await bodyAt(LINK_PATH)).toBe('the server copy');
  });

  it('does not upload an entity rewritten after the queue was read', async () => {
    // Device extraction's two passes: the title is queued, the cycle reads its
    // queue — and then the image lands, with the patch that names it. An op carries
    // no bytes, so this copy uploaded the row as it stood by then: metadata naming a
    // `files/` blob the cycle held no op for and had not sent.
    await writeExtraction(USER, 'l_a', { fields: { title: 'A title' } });
    let landed = false;

    await runIncrementalSync(
      deps({
        filesSign: async (_paths, op) => {
          if (op !== 'put' || landed) return;
          landed = true;
          await seedQueuedContent(FILE_ID, 'image bytes');
          await writeExtraction(USER, 'l_a', { fields: { imageId: FILE_ID } });
        },
      }),
    );

    expect(mockPutBlob).not.toHaveBeenCalled();
    expect(mockPutBlobFromFile).not.toHaveBeenCalled();
    expect(committedPaths()).toEqual([]);
    expect(await pendingPaths()).toEqual([EXTRACTION_PATH, FILE_PATH]);

    // The next cycle reads both ops and carries them in order, content first.
    await runIncrementalSync(deps());
    expect(commits.map((batch) => batch.map((o) => o.path))).toEqual([
      [FILE_PATH],
      [EXTRACTION_PATH],
    ]);
    expect(uploadedFiles.get(FILE_PATH)).toBe('enc:image bytes');
    expect(await pendingPaths()).toEqual([]);
  });
});

// A cycle that writes BULK_CYCLE_PATHS or more holds live reads for its writes, so
// the restamp of every commit and every record a pull stores don't each re-run the
// reads on screen. A cycle below it must not hold: each edit kicks one, and an edit
// made during a held cycle would wait for the flush to render. And no cycle may
// leave a hold behind, or every live read in the app re-runs only on the flush from
// then on, with nothing to say why.
describe('the live-read hold', () => {
  const inWindow = (): OpsListReply => ({
    ops: [],
    oldestUpdatedAt: 500,
    newestUpdatedAt: 1500,
    hasMore: false,
  });
  const manyLinkPaths = (n: number): string[] =>
    Array.from({ length: n }, (_, i) =>
      pathFromId(`l_${String(i).padStart(3, '0')}`, LINKS_PREFIX),
    );

  it('holds a bulk push while it commits and releases it after', async () => {
    for (const path of manyLinkPaths(120)) seedQueued(path, 'imported');
    const heldAtCommit: boolean[] = [];

    await runIncrementalSync(
      deps({ opsList: inWindow, opsCommit: () => void heldAtCommit.push(liveReadsHeld()) }),
    );

    expect(heldAtCommit.length).toBeGreaterThan(0);
    expect(heldAtCommit.every(Boolean)).toBe(true);
    expect(liveReadsHeld()).toBe(false);
    expect(await pendingPaths()).toEqual([]);
  });

  it('holds a bulk pull while it stores the records', async () => {
    const paths = manyLinkPaths(120);
    const heldAtGet: boolean[] = [];
    mockGetBlob.mockImplementation(async () => {
      heldAtGet.push(liveReadsHeld());
      return new Uint8Array([0xee, ...utf8('from another device')]);
    });

    await runIncrementalSync(
      deps({
        opsList: () => ({
          ...inWindow(),
          ops: paths.map((path, i) => ({ op: 'put' as const, path, updatedAt: 1100 + i })),
        }),
      }),
    );

    expect(heldAtGet).toHaveLength(paths.length);
    expect(heldAtGet.every(Boolean)).toBe(true);
    expect(liveReadsHeld()).toBe(false);
    expect(await bodyAt(paths[0])).toBe('from another device');
  });

  it('does not hold an ordinary cycle', async () => {
    seedQueued(LINK_PATH, 'one edit');
    const heldAtCommit: boolean[] = [];

    await runIncrementalSync(
      deps({ opsList: inWindow, opsCommit: () => void heldAtCommit.push(liveReadsHeld()) }),
    );

    expect(heldAtCommit).toEqual([false]);
  });

  it('releases the hold when a bulk cycle fails', async () => {
    for (const path of manyLinkPaths(120)) seedQueued(path, 'imported');

    await expect(
      runIncrementalSync(
        deps({
          opsList: inWindow,
          filesSign: () => {
            throw new ApiError(400, JSON.stringify({ error: 'bad_request' }));
          },
        }),
      ),
    ).rejects.toThrow();

    expect(liveReadsHeld()).toBe(false);
  });
});

// L2, the cycle's own second pass — web engine's spec carries the full set; these
// are the drift guards for this copy of it, one per transport.
describe('the second pass', () => {
  it('sends an entity again under a freshly signed url after its token expired', async () => {
    await seedQueued(LINK_PATH, 'the link');
    let expiries = 1;
    mockPutBlob.mockImplementation(async (url: string) => {
      if (expiries-- > 0) throw EXPIRED_URL;
      uploaded.add(pathFor(url));
      return receiptFor(pathFor(url));
    });

    await runIncrementalSync(deps());

    expect(mockPutBlob).toHaveBeenCalledTimes(2);
    expect(committedPaths()).toEqual([LINK_PATH]);
    expect(await pendingPaths()).toEqual([]);
  });

  // A content op seals a fresh temp per attempt and deletes it either way; the
  // second pass must not find the first pass's temp gone and call that an orphan.
  it('sends content again from a freshly sealed file, and clears both temps', async () => {
    await seedQueuedContent(FILE_ID, 'image bytes');
    let expiries = 1;
    mockPutBlobFromFile.mockImplementation(async (url: string, file: { uri: string }) => {
      if (expiries-- > 0) throw EXPIRED_URL;
      uploaded.add(pathFor(url));
      uploadedFiles.set(pathFor(url), readFileText(file.uri));
      return receiptFor(pathFor(url));
    });

    await runIncrementalSync(deps());

    expect(uploadedFiles.get(FILE_PATH)).toBe('enc:image bytes');
    expect(await pendingPaths()).toEqual([]);
    expect(tempFiles()).toEqual([]);
  });

  it('pulls an entry once more after its GET token expired', async () => {
    let expiries = 1;
    mockGetBlob.mockImplementation(async (url: string) => {
      if (expiries-- > 0) throw new BlobRequestError('GET', 403);
      return new Uint8Array([0xee, ...utf8(`server ${pathFor(url)}`)]);
    });

    await runIncrementalSync(
      deps({
        opsList: () => ({
          ops: [{ op: 'put', path: LINK_PATH, updatedAt: 2000 }],
          oldestUpdatedAt: 500,
          newestUpdatedAt: 2000,
          hasMore: false,
        }),
      }),
    );

    expect(mockGetBlob).toHaveBeenCalledTimes(2);
    expect(await bodyAt(LINK_PATH)).toBe(`server ${LINK_PATH}`);
  });
});
