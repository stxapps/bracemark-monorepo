// Sync-engine specs, weighted toward the CONCURRENCY hazard the engine's shape
// creates: a cycle reads the pending-ops queue ONCE at the top and then spends many
// round trips on the network, while this device keeps writing. Every "the local write
// survives" case below is a real bug that shipped (see applyDeletes / putPulled in
// engine.ts, and docs/local-first-sync.md — a sync cycle), and each has a paired
// control case asserting the guard didn't just disable the reconcile it protects.
//
// The seam under test is the whole cycle, driven through a stubbed ApiClient: the
// engine takes its api in `SyncDeps` (never a module singleton) precisely so a test
// can hand it one. The mid-cycle write is injected FROM a stub handler — that's what
// puts it after the snapshot and before the apply, deterministically, with no timers.

import {
  ApiError,
  DEFAULT_LIST_ID,
  filesListEndpoint,
  filesSignEndpoint,
  opsCommitEndpoint,
  opsListEndpoint,
  SETTINGS_GENERAL_PATH,
  TRASH_ID,
  utf8,
} from '@stxapps/shared';

import { db } from '../data/db';
import {
  deleteExtraction,
  deleteFile,
  deleteLink,
  deletePin,
  writeExtraction,
  writeLink,
} from '../data/mutations';
import { enqueuePut } from '../data/pending-store';
import { toItemRecord } from '../data/projection';
import {
  awaitInflightSync,
  loadEntityContent,
  runIncrementalSync,
  runInitialSync,
  type SyncDeps,
} from './engine';
import { BlobRequestError, getBlob, putBlob } from './r2';

// The crypto boundary is not what these specs are about: a reversible stand-in keeps
// the assertions on BYTES the test wrote, so "the local copy survived" is checkable by
// value. `encryptEntity` prefixes a marker byte, `decryptEntity` strips it.
jest.mock('@stxapps/web-crypto', () => ({
  encryptEntity: jest.fn(
    async (_key: unknown, bytes: Uint8Array) => new Uint8Array([0xee, ...bytes]),
  ),
  decryptEntity: jest.fn(async (_key: unknown, bytes: Uint8Array) => bytes.slice(1)),
  // Kept REAL (the module is mocked wholesale, so every export has to be restated):
  // `writeId` identity is the subject of the mid-push cases, and a stubbed generator
  // that repeated itself would make compare-and-delete look correct when it isn't.
  newId: () => globalThis.crypto.randomUUID(),
}));

// R2 is reached over presigned URLs with a bare fetch; stub the two movers. The real
// BlobRequestError class is kept because the engine branches on `instanceof` for 404s.
jest.mock('./r2', () => {
  const actual = jest.requireActual('./r2');
  return { ...actual, getBlob: jest.fn(), putBlob: jest.fn(async () => undefined) };
});

const mockGetBlob = getBlob as jest.MockedFunction<typeof getBlob>;
const mockPutBlob = putBlob as jest.MockedFunction<typeof putBlob>;

const USER = 'alice';
const LINK_PATH = 'links/l_a.enc';
const OTHER_LINK_PATH = 'links/l_b.enc';
const EXTRACTION_PATH = 'extractions/l_a.enc';
const FILE_PATH = 'files/f_a.enc';
const OTHER_FILE_PATH = 'files/f_b.enc';
// The one path every client rewrites in place, over and over — hence the push-window
// race below lands here first.
const SETTINGS_PATH = SETTINGS_GENERAL_PATH;

// --- the api stub ------------------------------------------------------------

interface OpsListReply {
  ops: { op: 'put' | 'delete'; path: string; updatedAt: number }[];
  oldestUpdatedAt: number | null;
  newestUpdatedAt: number | null;
  hasMore: boolean;
}

interface Handlers {
  opsList?: () => Promise<OpsListReply> | OpsListReply;
  filesList?: () =>
    Promise<{ path: string; updatedAt: number }[]> | { path: string; updatedAt: number }[];
  // Called with the paths being signed — the hook a test uses to land a write
  // mid-cycle. Returning an array signs only those (a test for the unsigned-path
  // branch); returning nothing signs them all. `op` is passed so a handler can
  // refuse PUT signing while leaving GETs alone, the way the quota gate does
  // (bracemark-api lib/quota.ts gates puts only).
  filesSign?: (paths: string[], op: 'put' | 'get') => Promise<string[] | void> | string[] | void;
  // The other mid-cycle hook: runs when the drain commits, i.e. after its bytes are
  // already on R2 — the window a re-edit of the same path falls into.
  opsCommit?: (paths: string[]) => Promise<void> | void;
  // Server clock for committed paths, so a test can assert the local restamp.
  commitUpdatedAt?: number;
}

// Every commit the cycle made, in call order — the phase-ordering assertions read this.
let commits: { op: string; path: string }[][];
// R2 objects this fake server holds, so `ops/commit` can enforce the real
// op-without-object rule instead of rubber-stamping every op.
let uploaded: Set<string>;

const urlFor = (path: string): string => `https://r2.test/${path}`;
const pathFor = (url: string): string => url.slice('https://r2.test/'.length);

// An ApiClient that dispatches on endpoint IDENTITY (not path strings), so a renamed
// route can't silently turn a handler into the "unexpected endpoint" throw below.
function makeApi(handlers: Handlers = {}): SyncDeps['api'] {
  const empty: OpsListReply = {
    ops: [],
    oldestUpdatedAt: null,
    newestUpdatedAt: null,
    hasMore: false,
  };
  return {
    call: async (endpoint: unknown, input: Record<string, unknown>) => {
      if (endpoint === opsListEndpoint) return (await handlers.opsList?.()) ?? empty;
      if (endpoint === filesListEndpoint) {
        return { files: (await handlers.filesList?.()) ?? [], nextPageToken: null };
      }
      if (endpoint === filesSignEndpoint) {
        const paths = input.paths as string[];
        const granted = (await handlers.filesSign?.(paths, input.op as 'put' | 'get')) ?? paths;
        return { urls: granted.map((path) => ({ path, url: urlFor(path) })) };
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
  return { username: USER, encryptionKey: {} as CryptoKey, api: makeApi(handlers) };
}

// --- local-store helpers -----------------------------------------------------

// A synced record with no local edit outstanding: bytes + the server's stamp, no op.
async function seedSynced(path: string, body: string, updatedAt: number): Promise<void> {
  await db.items.put(toItemRecord(path, updatedAt, utf8(body)));
}

// The write edge's own shape: the record and its pending op in ONE transaction
// (data/mutations.ts writeBytesWith). Used both to seed queued edits and, from inside
// an api handler, to land a write MID-CYCLE.
async function seedQueued(path: string, body: string, baseUpdatedAt = 0): Promise<void> {
  await db.transaction('rw', db.items, db.pendingOps, async () => {
    await db.items.put(toItemRecord(path, baseUpdatedAt, utf8(body)));
    // Through the real enqueue, so the row carries a fresh `writeId` — re-seeding the
    // same path here has to be a distinguishable second WRITE, exactly as a second
    // click in the UI is, or the mid-push cases below would test nothing.
    await enqueuePut(USER, path, baseUpdatedAt);
  });
}

function pendingPaths(): Promise<string[]> {
  return db.pendingOps
    .where('username')
    .equals(USER)
    .toArray()
    .then((ops) => ops.map((o) => o.path).sort());
}

async function bodyAt(path: string): Promise<string | undefined> {
  const rec = await db.items.get(path);
  return rec?.data ? new TextDecoder().decode(rec.data) : undefined;
}

const committedPaths = (): string[] => commits.flat().map((o) => o.path);

// The real shape of a presigned PUT that outlived its 5-min TTL — R2 answers 403,
// which `putBlob` raises as this. Used by value so the specs can assert the cycle
// rejects with the TRANSPORT error itself, not a summary wrapped around it.
const EXPIRED_URL = new BlobRequestError('PUT', 403);

// Make the named paths' uploads fail while every other path still lands, so a spec
// can put a partial failure inside one chunk — the case that used to take the whole
// chunk down with it.
function failUploadsFor(...paths: string[]): void {
  const failing = new Set(paths);
  mockPutBlob.mockImplementation(async (url: string) => {
    const path = pathFor(url);
    if (failing.has(path)) throw EXPIRED_URL;
    uploaded.add(path);
  });
}

beforeEach(async () => {
  commits = [];
  uploaded = new Set();
  jest.clearAllMocks();
  mockPutBlob.mockImplementation(async (url: string) => {
    uploaded.add(pathFor(url));
  });
  await db.items.clear();
  await db.pendingOps.clear();
  await db.syncMeta.clear();
  // Past the first-sync gate, with a cursor inside the op log's retained range so a
  // test picks its cycle by what it makes ops/list answer, not by leftover state.
  await db.syncMeta.put({
    username: USER,
    syncCursorUpdatedAt: 1000,
    syncCursorPath: 'links/l_seed.enc',
    firstSyncDoneAt: 1,
  });
});

describe('waiting for an in-flight cycle', () => {
  it('reports a wait only when a cycle is actually running', async () => {
    const onIdleWait = jest.fn();
    await awaitInflightSync(USER, onIdleWait);
    expect(onIdleWait).not.toHaveBeenCalled();

    let release!: (reply: OpsListReply) => void;
    const blockedList = new Promise<OpsListReply>((resolve) => {
      release = resolve;
    });
    const cycle = runIncrementalSync(deps({ opsList: () => blockedList }));
    const onWait = jest.fn();
    const waiting = awaitInflightSync(USER, onWait);

    expect(onWait).toHaveBeenCalledTimes(1);
    release({
      ops: [],
      oldestUpdatedAt: 500,
      newestUpdatedAt: 1000,
      hasMore: false,
    });
    await Promise.all([cycle, waiting]);
  });
});

// --- the reported bug --------------------------------------------------------

describe('a local write that lands mid-cycle', () => {
  // The extension's exact sequence: the popup saves a link and kicks a sync; the
  // background then extracts the active tab and writes `extractions/{id}.enc` while
  // that cycle is still listing. The write is local-only and absent from the cycle's
  // pending snapshot, so the fallback's "local only, not queued → it was deleted
  // server-side" row used to match a brand-new create and delete it — leaving the
  // pending op behind, unpushable forever (no bytes to upload → `no_object` → requeued),
  // which is what wedged the popup's pending count at 1.
  it('is not deleted by the fallback cycle, and still syncs after', async () => {
    await seedQueued(LINK_PATH, 'the link');

    // Empty op log under a returning client → fallback (needsFallback). The extraction
    // lands while the full listing is in flight — after `listPendingOps`, before the
    // local-delete reconcile.
    const first = deps({
      filesList: async () => {
        await writeExtraction(USER, 'l_a', { fields: { title: 'Google' } });
        return [];
      },
    });
    await runIncrementalSync(first);

    const extraction = await db.items.get(EXTRACTION_PATH);
    expect(extraction).toBeDefined();
    expect(await pendingPaths()).toEqual([EXTRACTION_PATH]); // the link's op drained
    expect(committedPaths()).toEqual([LINK_PATH]);

    // And the queue is not wedged: the very next cycle pushes it.
    commits = [];
    await runIncrementalSync(deps());
    expect(mockPutBlob).toHaveBeenCalledWith(
      `https://r2.test/${EXTRACTION_PATH}`,
      expect.any(Uint8Array),
    );
    expect(committedPaths()).toEqual([EXTRACTION_PATH]);
    expect(await pendingPaths()).toEqual([]);
  });

  it('is not deleted by an incremental cycle that pulled a delete for it', async () => {
    await seedSynced(EXTRACTION_PATH, 'stale', 1500);

    await runIncrementalSync(
      deps({
        opsList: async () => {
          // The re-extraction lands after the snapshot: local-wins must hold even
          // though the server says this path is gone.
          await seedQueued(EXTRACTION_PATH, 'fresh title', 1500);
          return {
            ops: [{ op: 'delete', path: EXTRACTION_PATH, updatedAt: 2000 }],
            oldestUpdatedAt: 500,
            newestUpdatedAt: 2000,
            hasMore: false,
          };
        },
      }),
    );

    expect(await bodyAt(EXTRACTION_PATH)).toBe('fresh title');
    expect(await pendingPaths()).toEqual([EXTRACTION_PATH]);
  });

  it('is not overwritten by a download the same cycle pulled for its path', async () => {
    await seedSynced(LINK_PATH, 'server copy', 1500);
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('server copy v2')]));

    await runIncrementalSync(
      deps({
        opsList: () => ({
          ops: [{ op: 'put', path: LINK_PATH, updatedAt: 2000 }],
          oldestUpdatedAt: 500,
          newestUpdatedAt: 2000,
          hasMore: false,
        }),
        // The user edits the link while its download is being signed.
        filesSign: async () => {
          await seedQueued(LINK_PATH, 'my edit', 1500);
        },
      }),
    );

    // Local-wins: the edit stands, and it's still queued to be pushed. Without the
    // guard the server bytes would land here AND the surviving op would then upload
    // them back — laundering the lost edit into a legitimate-looking commit.
    expect(await bodyAt(LINK_PATH)).toBe('my edit');
    expect(await pendingPaths()).toEqual([LINK_PATH]);
  });
});

describe('a local write that lands mid-PUSH', () => {
  // The sibling of the cases above, on the clear side rather than the apply side, and
  // the one the extension's options page hit: the theme picker rewrites the SAME path
  // on every click and kicks a sync each time, so click N+1 lands inside click N's
  // push window. The drain then cleared the queue BY PATH — deleting the op for an
  // edit it never uploaded. The local store kept the new theme with nothing queued to
  // carry it: no error, no pending count, no retry, and the setting never reached the
  // other devices.
  it('keeps its pending op when the commit clears the write before it', async () => {
    await seedQueued(SETTINGS_PATH, 'theme: dark');

    await runIncrementalSync(
      deps({
        opsCommit: async () => {
          await seedQueued(SETTINGS_PATH, 'theme: system');
        },
      }),
    );

    // The bytes that went up are the ones the cycle read; the newer edit is still
    // queued behind them.
    expect(mockPutBlob).toHaveBeenCalledWith(
      urlFor(SETTINGS_PATH),
      new Uint8Array([0xee, ...utf8('theme: dark')]),
    );
    expect(await bodyAt(SETTINGS_PATH)).toBe('theme: system');
    expect(await pendingPaths()).toEqual([SETTINGS_PATH]);
  });

  it('carries that write on the next cycle', async () => {
    await seedQueued(SETTINGS_PATH, 'theme: dark');
    await runIncrementalSync(
      deps({
        opsCommit: async () => {
          await seedQueued(SETTINGS_PATH, 'theme: system');
        },
      }),
    );

    await runIncrementalSync(deps());

    expect(mockPutBlob).toHaveBeenLastCalledWith(
      urlFor(SETTINGS_PATH),
      new Uint8Array([0xee, ...utf8('theme: system')]),
    );
    expect(await pendingPaths()).toEqual([]);
  });

  it('keeps a re-create that lands while its orphaned op is being dropped', async () => {
    // Same rule on the self-heal path: the drop is compare-and-delete too, so the
    // op minted by the re-create outlives the one the drain gave up on.
    await db.pendingOps.put({
      username: USER,
      path: EXTRACTION_PATH,
      op: 'put',
      baseUpdatedAt: 0,
      writeId: 'stale-write',
    });

    await runIncrementalSync(
      deps({
        filesSign: async () => {
          await seedQueued(EXTRACTION_PATH, 'extracted again');
        },
      }),
    );

    expect(await pendingPaths()).toEqual([EXTRACTION_PATH]);
    expect(await bodyAt(EXTRACTION_PATH)).toBe('extracted again');
  });
});

// --- the controls: the guards must not disable the reconcile -----------------

describe('the local-wins guards do not weaken the reconcile', () => {
  it('still deletes a local-only record that has no pending op', async () => {
    await seedSynced(EXTRACTION_PATH, 'deleted on another device', 1500);

    await runIncrementalSync(deps({ filesList: () => [] }));

    expect(await db.items.get(EXTRACTION_PATH)).toBeUndefined();
  });

  it('still applies a pulled delete for a path with no pending op', async () => {
    await seedSynced(EXTRACTION_PATH, 'deleted on another device', 1500);

    await runIncrementalSync(
      deps({
        opsList: () => ({
          ops: [{ op: 'delete', path: EXTRACTION_PATH, updatedAt: 2000 }],
          oldestUpdatedAt: 500,
          newestUpdatedAt: 2000,
          hasMore: false,
        }),
      }),
    );

    expect(await db.items.get(EXTRACTION_PATH)).toBeUndefined();
  });

  it('still downloads a newer server copy of an unqueued path', async () => {
    await seedSynced(LINK_PATH, 'old', 1500);
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('new')]));

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

    expect(await bodyAt(LINK_PATH)).toBe('new');
    expect((await db.items.get(LINK_PATH))?.updatedAt).toBe(2000);
  });
});

// --- the self-heal -----------------------------------------------------------

describe('a pending put whose local record is gone', () => {
  // The state the pre-fix delete produced. It can never be satisfied — nothing will
  // put those bytes back — so retrying it forever is a queue that no cycle can drain.
  beforeEach(async () => {
    await db.pendingOps.put({
      username: USER,
      path: EXTRACTION_PATH,
      op: 'put',
      baseUpdatedAt: 0,
      writeId: 'orphan-write',
    });
  });

  it('is dropped from the queue instead of committed', async () => {
    await runIncrementalSync(deps());

    expect(await pendingPaths()).toEqual([]);
    expect(mockPutBlob).not.toHaveBeenCalled();
    // Never committed: an op logged for an object we didn't upload would 404 every
    // other device's puller (the op-without-object invariant).
    expect(committedPaths()).toEqual([]);
  });

  it('does not take the rest of the batch down with it', async () => {
    await seedQueued(LINK_PATH, 'the link');

    await runIncrementalSync(deps());

    expect(committedPaths()).toEqual([LINK_PATH]);
    expect(await pendingPaths()).toEqual([]);
  });
});

// --- the ordinary push -------------------------------------------------------

describe('the push', () => {
  it('uploads the encrypted local blob and restamps with the server clock', async () => {
    await seedQueued(LINK_PATH, 'the link');

    await runIncrementalSync(deps({ commitUpdatedAt: 7777 }));

    expect(mockPutBlob).toHaveBeenCalledWith(
      `https://r2.test/${LINK_PATH}`,
      new Uint8Array([0xee, ...utf8('the link')]),
    );
    expect((await db.items.get(LINK_PATH))?.updatedAt).toBe(7777);
    expect(await pendingPaths()).toEqual([]);
  });

  it('commits content before the metadata that references it', async () => {
    await seedQueued(FILE_PATH, 'image bytes');
    await seedQueued(EXTRACTION_PATH, 'refers to the image');

    await runIncrementalSync(deps());

    // Separate commit calls, content's first — so no crash mid-push can leave
    // metadata pointing at an object that was never uploaded.
    expect(commits.map((batch) => batch.map((o) => o.path))).toEqual([
      [FILE_PATH],
      [EXTRACTION_PATH],
    ]);
  });

  it('leaves a path queued when its sign call returned no url', async () => {
    await seedQueued(LINK_PATH, 'the link');

    // A path the signer skipped is TRANSIENT — unlike a missing local record the bytes
    // are still here, so the commit's `no_object` requeue IS the retry. This is the
    // case the orphan drop above must not swallow.
    await runIncrementalSync(deps({ filesSign: () => [] }));

    expect(mockPutBlob).not.toHaveBeenCalled();
    expect(await pendingPaths()).toEqual([LINK_PATH]);
    expect(await db.items.get(LINK_PATH)).toBeDefined();
  });
});

// --- a PUT that fails mid-chunk ----------------------------------------------

// The third skip shape (uploadBlobs): not a missing record and not an unsigned path,
// but a PUT that THREW — a network blip, or a presigned URL that expired because its
// chunk of `files/` content took longer than the 5-min TTL to upload. It used to
// escape the pool and abort the whole chunk before the chunk could commit ANYTHING,
// so a chunk too big to finish inside one TTL window re-signed and re-failed forever:
// a deterministic livelock that no retry could break, because every retry restarted
// the same too-big chunk.
describe('a transient upload failure', () => {
  it('rejects the cycle with the transport error rather than reporting a clean run', async () => {
    await seedQueued(LINK_PATH, 'the link');
    failUploadsFor(LINK_PATH);

    // A cycle that swallowed this would leave bgSyncStatus at 'idle' with the edit
    // silently unpushed — no error, nothing for the user to retry.
    await expect(runIncrementalSync(deps())).rejects.toBe(EXPIRED_URL);
  });

  it('leaves only the failed op queued, and commits the blobs that did land', async () => {
    await seedQueued(LINK_PATH, 'the link');
    await seedQueued(OTHER_LINK_PATH, 'the other link');
    failUploadsFor(LINK_PATH);

    await expect(runIncrementalSync(deps())).rejects.toBe(EXPIRED_URL);

    // Monotonic progress: the chunk still committed its survivor. The failed path is
    // NOT committed — asking the server to HEAD an object we know we didn't send is a
    // guaranteed `no_object`, and on a big failed chunk that's a thousand of them.
    expect(committedPaths()).toEqual([OTHER_LINK_PATH]);
    expect(await pendingPaths()).toEqual([LINK_PATH]);
  });

  it('drains on the next cycle, under a fresh url', async () => {
    await seedQueued(LINK_PATH, 'the link');
    failUploadsFor(LINK_PATH);
    await expect(runIncrementalSync(deps())).rejects.toBe(EXPIRED_URL);

    // The retry is the whole point of leaving it queued: same bytes, new presign.
    mockPutBlob.mockImplementation(async (url: string) => {
      uploaded.add(pathFor(url));
    });
    commits = [];
    await runIncrementalSync(deps());

    expect(mockPutBlob).toHaveBeenLastCalledWith(
      urlFor(LINK_PATH),
      new Uint8Array([0xee, ...utf8('the link')]),
    );
    expect(committedPaths()).toEqual([LINK_PATH]);
    expect(await pendingPaths()).toEqual([]);
  });

  it('holds the metadata phase when a content upload failed', async () => {
    await seedQueued(FILE_PATH, 'image bytes');
    await seedQueued(EXTRACTION_PATH, 'refers to the image');
    failUploadsFor(FILE_PATH);

    await expect(runIncrementalSync(deps())).rejects.toBe(EXPIRED_URL);

    // The metadata is never even uploaded, let alone committed: landing it now would
    // publish a record whose content 404s on every other device — the exact breach
    // the content-before-metadata phase order exists to prevent.
    expect(mockPutBlob).not.toHaveBeenCalledWith(urlFor(EXTRACTION_PATH), expect.anything());
    expect(committedPaths()).toEqual([]);
    expect(await pendingPaths()).toEqual([EXTRACTION_PATH, FILE_PATH]);
  });

  it('commits the content that landed even while holding the metadata phase', async () => {
    await seedQueued(FILE_PATH, 'image bytes');
    await seedQueued(OTHER_FILE_PATH, 'other image bytes');
    await seedQueued(EXTRACTION_PATH, 'refers to the images');
    failUploadsFor(FILE_PATH);

    await expect(runIncrementalSync(deps())).rejects.toBe(EXPIRED_URL);

    // Committing the content that made it is safe and is what makes a too-large push
    // shrink every cycle instead of livelocking; the metadata still waits for ALL of it,
    // because the engine is schema-blind and can't tell which metadata is safe.
    expect(committedPaths()).toEqual([OTHER_FILE_PATH]);
    expect(await pendingPaths()).toEqual([EXTRACTION_PATH, FILE_PATH]);
  });

  it('pushes both halves in order once the content lands', async () => {
    await seedQueued(FILE_PATH, 'image bytes');
    await seedQueued(EXTRACTION_PATH, 'refers to the image');
    failUploadsFor(FILE_PATH);
    await expect(runIncrementalSync(deps())).rejects.toBe(EXPIRED_URL);

    mockPutBlob.mockImplementation(async (url: string) => {
      uploaded.add(pathFor(url));
    });
    commits = [];
    await runIncrementalSync(deps());

    expect(commits.map((batch) => batch.map((o) => o.path))).toEqual([
      [FILE_PATH],
      [EXTRACTION_PATH],
    ]);
    expect(await pendingPaths()).toEqual([]);
  });
});

// --- the self-heal, completed ------------------------------------------------

// Dropping the wedged op (above) unwedges the QUEUE but, on its own, leaves the
// entity locally ABSENT: the reconcile had already reserved that path for the push
// — local-wins keeps every pending path out of the download set — so the server's
// copy was skipped for a push that then never happened. The heal has to put the
// path back into the download set after the drop, or the user's link stays missing
// on this device until some later fallback re-lists it.
describe('a dropped orphan’s server copy', () => {
  beforeEach(async () => {
    await db.pendingOps.put({
      username: USER,
      path: LINK_PATH,
      op: 'put',
      baseUpdatedAt: 0,
      writeId: 'orphan-write',
    });
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('the server copy')]));
  });

  it('is re-downloaded by the incremental cycle that dropped it', async () => {
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
    expect((await db.items.get(LINK_PATH))?.updatedAt).toBe(2000);
  });

  it('is re-downloaded by the fallback cycle that dropped it', async () => {
    await runIncrementalSync(deps({ filesList: () => [{ path: LINK_PATH, updatedAt: 2000 }] }));

    expect(await pendingPaths()).toEqual([]);
    expect(await bodyAt(LINK_PATH)).toBe('the server copy');
  });

  it('stays absent when the op that wrote it is behind the cursor', async () => {
    // The honest limit of the incremental heal: with no op for the path in this
    // window there is nothing to re-add, so the path waits for a fallback to
    // re-list it. Pinned so the heal isn't later "fixed" into inventing a download
    // for a path the server may no longer have.
    await runIncrementalSync(deps());

    expect(await pendingPaths()).toEqual([]);
    expect(await db.items.get(LINK_PATH)).toBeUndefined();
    expect(mockGetBlob).not.toHaveBeenCalled();
  });

  it('is not resurrected when the window shows the path deleted', async () => {
    await runIncrementalSync(
      deps({
        opsList: () => ({
          ops: [{ op: 'delete', path: LINK_PATH, updatedAt: 2000 }],
          oldestUpdatedAt: 500,
          newestUpdatedAt: 2000,
          hasMore: false,
        }),
      }),
    );

    expect(await pendingPaths()).toEqual([]);
    expect(await db.items.get(LINK_PATH)).toBeUndefined();
  });
});

// --- the over-quota escape hatch ---------------------------------------------

// docs/iap.md promises an over-quota account "read-only-plus-delete, never data
// loss". Whether the DELETE half is actually reachable rests on a chain nothing
// else covers end to end, and every link in it is silently breakable:
//
//   1. "Delete permanently" is offered only on links already in Trash
//      (link-row-menu.tsx / bulk-edit-toolbar.tsx, both keyed on `inTrash`);
//   2. getting a link there is `update({ listId: TRASH_ID })` — a `links/` put,
//      exactly what the quota gate refuses;
//   3. it works anyway because the move is LOCAL-FIRST (useLinkMutations.update
//      writes Dexie and calls requestSync() without awaiting it), so the link is
//      in Trash and offering its destroy whatever the server said; and
//   4. the destroy's `enqueueDelete` OVERWRITES the refused put in place
//      (put→delete, new writeId — data/pending-store.ts) rather than queueing
//      behind it, so the deletes ride `ops/commit`, which is ungated.
//
// Break any of those — gate the destroy on the trashed state having synced, make
// the Trash move await its push, queue the delete alongside the put instead of
// over it — and an account that is out of space can no longer get back under,
// with no test failing and no error to see. The whole point of the spec below is
// that it exercises the sequence a user performs, not the units.
describe('an over-quota account clearing space', () => {
  // What `files/sign` answers at the ceiling: 403 with bracemark-api's code, the
  // one the engine tells apart from an auth 403 (shared apiErrorCode).
  const QUOTA_EXCEEDED = new ApiError(403, JSON.stringify({ error: 'quota_exceeded' }));
  const refusePutSigning = (_paths: string[], op: 'put' | 'get'): never | void => {
    if (op === 'put') throw QUOTA_EXCEEDED;
  };
  // An op log with nothing new in it that still brackets the cursor, so the cycle
  // stays INCREMENTAL — an empty log would route to the fallback, whose reconcile
  // is a different subject.
  const quietLog = () => ({
    ops: [],
    oldestUpdatedAt: 500,
    newestUpdatedAt: 1500,
    hasMore: false,
  });

  const LINK_ID = 'l_a'; // LINK_PATH / EXTRACTION_PATH are this id's two halves
  const IMAGE_ID = 'f_a'; // FILE_PATH — the preview blob the link references
  const PIN_PATH = 'pins/l_a.enc';
  const linkBlob = {
    url: 'https://example.test/article',
    listId: DEFAULT_LIST_ID,
    tagIds: [],
    customImageId: IMAGE_ID,
    createdAt: 1000,
    updatedAt: 1000,
  };
  const listIdAt = async (path: string): Promise<string> =>
    (JSON.parse((await bodyAt(path)) ?? '{}') as { listId?: string }).listId ?? '';

  it('trashes locally under a refused push, then frees space by destroying', async () => {
    // A synced library: the link, its machine half, and the blob it references.
    await seedSynced(LINK_PATH, JSON.stringify(linkBlob), 1500);
    await seedSynced(EXTRACTION_PATH, JSON.stringify({ id: LINK_ID, facets: {} }), 1500);
    await seedSynced(FILE_PATH, 'preview bytes', 1500);

    // 1. Remove → Trash. The write edge does not consult the server, so this
    //    resolves and the row moves whatever the quota gate would say.
    await writeLink(USER, { path: LINK_PATH, ...linkBlob }, { listId: TRASH_ID });
    expect(await listIdAt(LINK_PATH)).toBe(TRASH_ID);

    // 2. The push of that move is refused — and the CYCLE STILL COMPLETES. A
    //    throw here would be the wedge signPushable exists to prevent.
    const refused = await runIncrementalSync(
      deps({ opsList: quietLog, filesSign: refusePutSigning }),
    );

    expect(refused.blocked).toBe(true);
    expect(refused.blockedCount).toBe(1);
    // Nothing committed, nothing dropped: the trashed state stands locally and its
    // op is still queued, which is what "never data loss" means here.
    expect(committedPaths()).toEqual([]);
    expect(await listIdAt(LINK_PATH)).toBe(TRASH_ID);
    expect(await pendingPaths()).toEqual([LINK_PATH]);

    // 3. The row is in Trash, so it now offers "Delete permanently". Destroy in
    //    useLinkMutations.destroy's order: content, then the satellites, then the
    //    link (an absent pin still queues its tombstone).
    await deleteFile(USER, IMAGE_ID);
    await deleteExtraction(USER, LINK_ID);
    await deletePin(USER, LINK_ID);
    await deleteLink(USER, { path: LINK_PATH, ...linkBlob });

    // The refused put was FLIPPED to a delete in place — one row for the path, not
    // a delete queued behind a put that can never drain.
    const queued = await db.pendingOps.where('username').equals(USER).toArray();
    expect(queued.filter((o) => o.path === LINK_PATH).map((o) => o.op)).toEqual(['delete']);

    // 4. Still over quota — every put is still refused — but deletes never reach
    //    files/sign, so the space comes back and the queue drains to empty.
    commits = [];
    const freed = await runIncrementalSync(
      deps({ opsList: quietLog, filesSign: refusePutSigning }),
    );

    expect(freed.blocked).toBe(false); // nothing left that the gate could refuse
    expect(commits.flat().every((o) => o.op === 'delete')).toBe(true);
    expect(committedPaths().sort()).toEqual(
      [EXTRACTION_PATH, FILE_PATH, LINK_PATH, PIN_PATH].sort(),
    );
    expect(await pendingPaths()).toEqual([]);
    expect(await db.items.get(LINK_PATH)).toBeUndefined();
  });

  it('refuses the put without touching the deletes in the same cycle', async () => {
    // The control: a cycle carrying BOTH is not all-or-nothing. Deletes commit
    // (phase 1+2, before any signing), the put is refused, and the two outcomes
    // don't contaminate each other — which is what lets step 3 above be one user
    // gesture rather than a sequence they have to get right.
    await seedSynced(LINK_PATH, JSON.stringify(linkBlob), 1500);
    await seedSynced(OTHER_LINK_PATH, JSON.stringify(linkBlob), 1500);

    await writeLink(USER, { path: LINK_PATH, ...linkBlob }, { listId: TRASH_ID });
    await deleteLink(USER, { path: OTHER_LINK_PATH, ...linkBlob });

    const outcome = await runIncrementalSync(
      deps({ opsList: quietLog, filesSign: refusePutSigning }),
    );

    expect(outcome.blocked).toBe(true);
    expect(committedPaths()).toEqual([OTHER_LINK_PATH]);
    expect(await pendingPaths()).toEqual([LINK_PATH]);
  });
});

// --- the lazy content cache --------------------------------------------------

// loadEntityContent caches the blob it decrypted into the record, so re-views are
// instant and offline. The hazard is that the fetch spans network round trips a sync
// pull can land inside: if the pull restamps the path to a NEWER version (dropping
// its cached bytes), writing the older blob under that new stamp pins stale content
// FOREVER — storeDownloads only re-downloads when the server stamp moves again, and
// it just did. Hence the compare-and-set on the stamp the fetch started from.
describe('loadEntityContent', () => {
  beforeEach(async () => {
    await db.items.put(toItemRecord(FILE_PATH, 1000));
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('page copy')]));
  });

  it('caches the decrypted blob when the record has not moved', async () => {
    const data = await loadEntityContent(deps(), FILE_PATH);

    expect(new TextDecoder().decode(data)).toBe('page copy');
    expect(await bodyAt(FILE_PATH)).toBe('page copy');
  });

  it('returns the bytes but skips the cache when the record was restamped mid-fetch', async () => {
    const data = await loadEntityContent(
      deps({
        // A pull lands the newer version while this fetch is being signed — exactly
        // what storeDownloads writes for a content path: a new stamp, no bytes.
        filesSign: async () => {
          await db.items.put(toItemRecord(FILE_PATH, 2000));
        },
      }),
      FILE_PATH,
    );

    // The caller still gets what it asked for — losing the race costs a cache write,
    // not the read. But the OLD bytes must not be sitting under the NEW stamp.
    expect(new TextDecoder().decode(data)).toBe('page copy');
    expect(await bodyAt(FILE_PATH)).toBeUndefined();
    expect((await db.items.get(FILE_PATH))?.updatedAt).toBe(2000);
  });

  it('serves an already-cached blob without a round trip', async () => {
    await db.items.put(toItemRecord(FILE_PATH, 1000, utf8('page copy')));

    const data = await loadEntityContent(deps(), FILE_PATH);

    expect(new TextDecoder().decode(data)).toBe('page copy');
    expect(mockGetBlob).not.toHaveBeenCalled();
  });
});

// --- the first-sync counter --------------------------------------------------

// What the decrypting screen (bracemark-web components/initial-sync-gate.tsx) puts a
// number on. The number is only worth showing if the denominator is what the pull
// actually fetches and the count always arrives at it: this is a blocking screen with
// nothing else on it, so a counter that stops at 4 of 6 reads as a hang, and a
// denominator padded with work that costs no time reads as a stall near the end.
describe('the first-sync counter', () => {
  const LISTING = [
    { path: LINK_PATH, updatedAt: 100 },
    { path: OTHER_LINK_PATH, updatedAt: 101 },
    { path: EXTRACTION_PATH, updatedAt: 102 },
    // Listed, and it carries the cursor like any other path — but its blob is
    // deferred (content downloads lazily, never on first sync), so it must not
    // inflate the total.
    { path: FILE_PATH, updatedAt: 103 },
  ];

  // A pull that streams back the path itself as its plaintext, through the marker
  // byte the crypto stand-in at the top of this file strips.
  const serveBlobs = (missing?: string) =>
    mockGetBlob.mockImplementation(async (url: string) => {
      const path = pathFor(url);
      if (path === missing) throw new BlobRequestError('GET', 404);
      return new Uint8Array([0xee, ...utf8(path)]);
    });

  beforeEach(async () => {
    // No first-sync flag — this IS the first sync (the shared beforeEach seeds a
    // returning client).
    await db.syncMeta.clear();
    serveBlobs();
  });

  function recordTicks(): {
    ticks: [number, number][];
    onProgress: (d: number, t: number) => void;
  } {
    const ticks: [number, number][] = [];
    return { ticks, onProgress: (done, total) => ticks.push([done, total]) };
  }

  it('counts the index blobs only, and opens at zero before the first GET', async () => {
    const { ticks, onProgress } = recordTicks();

    await runInitialSync(deps({ filesList: () => LISTING }), onProgress);

    // Three index paths out of four listed: the `files/` entry is not downloaded.
    expect(ticks[0]).toEqual([0, 3]);
    // Opening at zero is what lets the gate swap its indeterminate state for a real
    // bar immediately, instead of waiting out the first round trip.
    expect(ticks.map(([done]) => done)).toEqual([0, 1, 2, 3]);
    expect(ticks.every(([, total]) => total === 3)).toBe(true);
  });

  it('reaches its total even when a path is deleted mid-pull', async () => {
    // The 404 skip: the delete op sits past our window and reconciles next cycle, so
    // the entry is dropped rather than failing the run. The work it stood for is
    // still off the list, and a counter that ignored it would stall one short of the
    // end — the exact shape of a hang.
    serveBlobs(EXTRACTION_PATH);
    const { ticks, onProgress } = recordTicks();

    await runInitialSync(deps({ filesList: () => LISTING }), onProgress);

    expect(ticks.at(-1)).toEqual([3, 3]);
  });

  it('skips what the store already has, and counts only the remainder', async () => {
    // A re-run after an interruption resumes rather than restarting, so the total
    // shrinks to the work actually left. The count stays honest about THIS attempt
    // (see the staleness skip in storeDownloads).
    await seedSynced(LINK_PATH, 'the link', 100);
    const { ticks, onProgress } = recordTicks();

    await runInitialSync(deps({ filesList: () => LISTING }), onProgress);

    expect(ticks[0]).toEqual([0, 2]);
    expect(ticks.at(-1)).toEqual([2, 2]);
  });

  it('reports nothing at all when there is nothing to download', async () => {
    // The gate reads "no number" as the indeterminate state it already shows while
    // the manifest is listing — better than flashing a full bar over a pull that was
    // over before it started.
    const { ticks, onProgress } = recordTicks();

    await runInitialSync(deps({ filesList: () => [] }), onProgress);

    expect(ticks).toEqual([]);
  });

  it('is optional — the browser extension passes no reporter', async () => {
    await expect(runInitialSync(deps({ filesList: () => LISTING }))).resolves.toBeUndefined();
    expect(await bodyAt(LINK_PATH)).toBe(LINK_PATH);
  });
});
