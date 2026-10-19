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
  ApiTimeoutError,
  BlobUnreadableError,
  createApiClient,
  createSyncTraceRecorder,
  DEFAULT_LIST_ID,
  filesListEndpoint,
  filesSignEndpoint,
  opsCommitEndpoint,
  opsListEndpoint,
  SETTINGS_GENERAL_PATH,
  TRASH_ID,
  utf8,
} from '@stxapps/shared';
import { decryptEntity, encryptEntity } from '@stxapps/web-crypto';

import { db } from '../data/db';
import {
  deleteExtraction,
  deleteFile,
  deleteLink,
  deletePin,
  writeExtraction,
  writeFile,
  writeLink,
} from '../data/mutations';
import { enqueuePut } from '../data/pending-store';
import { toItemRecord } from '../data/projection';
import { beginInitialSync, getSyncMeta } from '../data/sync-store';
import { AccountFencedError } from '../data/sync-store';
import {
  holdSyncCycles,
  installSyncTrace,
  loadEntityContent,
  loadEntityContents,
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
// Every files/sign request's transport, in order.
let signVias: unknown[];
// R2 objects this fake server holds, so `ops/commit` can enforce the real
// op-without-object rule instead of rubber-stamping every op.
let uploaded: Set<string>;

const urlFor = (path: string): string => `https://r2.test/${path}`;
const pathFor = (url: string): string => url.slice('https://r2.test/'.length);
// What files/sign answers a `via: 'api'` request with beside the URL: the blob
// route's token for that path, which the engine must send as the header. The URLs
// above stay per-path so a mock can tell the transfers apart; the engine treats
// both as opaque.
const tokenFor = (path: string): string => `Blob token-for-${path}`;

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
        signVias.push(input.via);
        const paths = input.paths as string[];
        const granted = (await handlers.filesSign?.(paths, input.op as 'put' | 'get')) ?? paths;
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
  signVias = [];
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

// The delete-all flow's hold: its server wipe and local wipe run with no cycle beside
// them. A cycle already running is waited out; one asked for meanwhile waits for the
// work. Asked of the real cycle lock, through the real single-flight slot.
describe('holding the sync cycles off', () => {
  const EMPTY_PAGE: OpsListReply = {
    ops: [],
    oldestUpdatedAt: 500,
    newestUpdatedAt: 1000,
    hasMore: false,
  };

  // A cycle stopped at its first call, so the test decides when it may finish.
  function blockedCycle(order: string[]): { cycle: Promise<unknown>; finish: () => void } {
    let finish!: () => void;
    const answered = new Promise<OpsListReply>((resolve) => {
      finish = () => {
        order.push('cycle done');
        resolve(EMPTY_PAGE);
      };
    });
    const cycle = runIncrementalSync(deps({ opsList: () => answered }));
    return { cycle, finish };
  }

  it('reports a wait only when a cycle is actually running', async () => {
    const onIdleWait = jest.fn();
    await holdSyncCycles(USER, async () => undefined, { onWait: onIdleWait });
    expect(onIdleWait).not.toHaveBeenCalled();

    const order: string[] = [];
    const { cycle, finish } = blockedCycle(order);
    // Let the cycle reach its lock before the hold asks for it.
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
    finish();
    await Promise.all([cycle, held]);
    // The work ran after the cycle, never beside it.
    expect(order).toEqual(['cycle done', 'work']);
  });

  // The whole point: a cycle asked for while the work runs (a timer, an edit, another
  // tab) does not so much as list until the work is over — it would push the queue past
  // a server wipe, or pull over edits a refused one was meant to keep.
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

  // The signal is the caller's watchdog on the WAIT. Given up on, the work must never
  // run later — a delete that starts minutes after it reported a failure.
  it('never runs the work when the wait is aborted', async () => {
    const order: string[] = [];
    const { cycle, finish } = blockedCycle(order);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const watchdog = new AbortController();
    const work = jest.fn(async () => undefined);
    const held = holdSyncCycles(USER, work, { signal: watchdog.signal });

    watchdog.abort(new Error('too slow'));
    await expect(held).rejects.toThrow('too slow');
    finish();
    await cycle;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(work).not.toHaveBeenCalled();
  });

  it('settles with the work’s own outcome', async () => {
    await expect(holdSyncCycles(USER, async () => 42)).resolves.toBe(42);
    await expect(
      holdSyncCycles(USER, async () => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
    // And the lock is free again after a failure: a cycle runs.
    await expect(runIncrementalSync(deps({ opsList: () => EMPTY_PAGE }))).resolves.toBeDefined();
  });
});

// The single-flight slot is freed only when the cycle's promise settles, and every
// later caller — background sync, a refresh, export's and import's pre-sync,
// delete-all's wait — joins the one in flight. So a cycle that never settles is not
// one stuck export: it is sync gone for the rest of the page. A server that accepts
// the connection and never answers did exactly that, because `fetch` has no deadline
// of its own. Driven through the REAL contract client over a fetch that never
// answers (and ignores its abort), since the deadline lives in the client, not in
// the stub the rest of this file uses.
describe('a server that accepts the connection and never answers', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  // Its own account, so a regression fails HERE: a cycle that never settles holds
  // its user's slot for the rest of the file, and under USER every later case would
  // join it and time out one by one — the bug reproducing itself, far from its cause.
  const HUNG_USER = 'never-answered';

  it('fails the cycle at the call deadline, unretried, and frees the slot', async () => {
    // Only the timers the deadline and the retry backoff use; fake-indexeddb
    // schedules its own work on setImmediate and must keep running.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    let reached!: () => void;
    const fetchReached = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const hangingFetch = jest.fn(() => {
      reached();
      return new Promise<Response>(() => undefined);
    });
    const api = createApiClient({
      baseUrl: 'https://api.test',
      fetch: hangingFetch as unknown as typeof fetch,
    });

    const outcome = runIncrementalSync({
      username: HUNG_USER,
      encryptionKey: {} as CryptoKey,
      api,
    }).catch((err: unknown) => err);
    await fetchReached;
    // Any deadline worth having is well inside five minutes.
    await jest.advanceTimersByTimeAsync(5 * 60_000);

    expect(await outcome).toBeInstanceOf(ApiTimeoutError);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
    // The slot is free: the next cycle runs against a healthy server rather than
    // joining the dead one.
    jest.useRealTimers();
    await expect(runIncrementalSync({ ...deps(), username: HUNG_USER })).resolves.toBeDefined();
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
      tokenFor(EXTRACTION_PATH),
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
      tokenFor(SETTINGS_PATH),
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
      tokenFor(SETTINGS_PATH),
    );
    expect(await pendingPaths()).toEqual([]);
  });

  it('keeps a re-create that lands under an op the drain could never have satisfied', async () => {
    // Same rule on the self-heal path. The stale op has no bytes, and by the time
    // its upload is read the path has been written again — so the queue row is a
    // different write, and the drain neither drops it as an orphan nor uploads for
    // it. The op minted by the re-create outlives the one the drain gave up on.
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
      tokenFor(LINK_PATH),
    );
    expect((await db.items.get(LINK_PATH))?.updatedAt).toBe(7777);
    expect(await pendingPaths()).toEqual([]);
  });

  // R2's S3 endpoint is HTTP/1.1: six sockets per host in a browser, and a
  // preflight before every PUT. The blob route is one HTTP/2 or HTTP/3
  // connection, so every sign asks for it, and every transfer carries the token
  // it was answered with (docs/local-first-sync.md, _the blob route_).
  it('asks for the blob route and sends its token on every transfer', async () => {
    await seedQueued(LINK_PATH, 'the link');
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('the server copy')]));

    await runIncrementalSync(
      deps({
        opsList: () => ({
          ops: [{ op: 'put', path: OTHER_LINK_PATH, updatedAt: 2000 }],
          oldestUpdatedAt: 500,
          newestUpdatedAt: 2000,
          hasMore: false,
        }),
      }),
    );

    expect(signVias).toEqual(['api', 'api']); // the push's put, the pull's get
    expect(mockPutBlob).toHaveBeenCalledWith(
      urlFor(LINK_PATH),
      expect.any(Uint8Array),
      tokenFor(LINK_PATH),
    );
    expect(mockGetBlob).toHaveBeenCalledWith(urlFor(OTHER_LINK_PATH), tokenFor(OTHER_LINK_PATH));
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
// --- the timing trace ---------------------------------------------------------

// The spans `measure:sync` reads (@stxapps/shared sync/trace.ts). Pinned by name,
// because the runner's report and both engines share the vocabulary: a span that
// quietly moved or vanished would leave a phase's time unaccounted for, and the
// reading would blame the rest.
describe('the timing trace', () => {
  afterEach(() => installSyncTrace(undefined));

  it('records each phase of a push, and a PUT span per blob with its size', async () => {
    const trace = createSyncTraceRecorder();
    installSyncTrace(trace);
    await seedQueued(FILE_PATH, 'image bytes');
    await seedQueued(LINK_PATH, 'the link');

    await runIncrementalSync(deps());

    const names = trace.spans.map((s) => s.name);
    for (const name of [
      'cycle.lock',
      'queue.read',
      'api /v1/ops/list',
      'push',
      'push.chunk',
      'api /v1/files/sign',
      'upload',
      'blob.read',
      'blob.encrypt',
      'blob.put',
      'commit',
      'api /v1/ops/commit',
      'commit.restamp',
      'commit.clear',
      'cycle',
    ]) {
      expect(names).toContain(name);
    }
    // The stub's op log is empty, which routes the cycle to the fallback.
    expect(trace.spans.find((s) => s.name === 'cycle')?.attrs).toEqual({
      kind: 'fallback',
      pending: 2,
    });
    expect(trace.spans.filter((s) => s.name === 'push.chunk').map((s) => s.attrs?.kind)).toEqual([
      'content',
      'index',
    ]);
    expect(trace.spans.filter((s) => s.name === 'blob.put').map((s) => s.attrs)).toEqual([
      { ns: 'files', bytes: 12 },
      { ns: 'links', bytes: 9 },
    ]);
  });
});

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
      tokenFor(LINK_PATH),
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
    expect(mockPutBlob.mock.calls.map(([url]) => url)).not.toContain(urlFor(EXTRACTION_PATH));
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

  it('holds the metadata behind refused content, even when the gate would let it through', async () => {
    // The gate reads usage at each call, so a delete committed by another device or
    // a purchase that raised the ceiling can land between the content sign and the
    // metadata one. Asking again there would push a link naming an image the server
    // never got — the breach content-before-metadata exists to prevent.
    // A new link and the custom image it names, both still queued.
    await seedQueued(FILE_PATH, 'preview bytes');
    await seedQueued(LINK_PATH, JSON.stringify(linkBlob));

    let putSigns = 0;
    const refused = await runIncrementalSync(
      deps({
        opsList: quietLog,
        filesSign: (_paths, op) => {
          if (op !== 'put') return;
          putSigns += 1;
          if (putSigns === 1) throw QUOTA_EXCEEDED;
        },
      }),
    );

    expect(putSigns).toBe(1);
    expect(committedPaths()).toEqual([]);
    expect(refused.blockedCount).toBe(2);
    expect(await pendingPaths()).toEqual([FILE_PATH, LINK_PATH].sort());

    // The control: once the content fits, both halves go up, content first.
    commits = [];
    const fits = await runIncrementalSync(deps({ opsList: quietLog }));

    expect(fits.blocked).toBe(false);
    expect(commits.map((batch) => batch.map((o) => o.path))).toEqual([[FILE_PATH], [LINK_PATH]]);
    expect(await pendingPaths()).toEqual([]);
  });
});

// --- the put chunk, per blob kind --------------------------------------------

// A chunk is the step the pending count moves in — its ops leave the queue only
// when it commits — so a `files/` chunk at the full commit cap froze "N changes
// waiting to sync" for minutes on an ordinary uplink, and ran long enough for its
// tail to outlive the presigned-URL TTL. Content chunks are smaller than index
// chunks for that; index chunks stay at the cap, where every extra chunk is two
// more calls against the `tight` rate limit (docs/local-first-sync.md, _a push is
// chunked_).
describe('the put chunk', () => {
  const quietLog = () => ({
    ops: [],
    oldestUpdatedAt: 500,
    newestUpdatedAt: 1500,
    hasMore: false,
  });
  const QUOTA_EXCEEDED = new ApiError(403, JSON.stringify({ error: 'quota_exceeded' }));
  // Enough of each kind that a content chunk can't hold them all and an index one can.
  const COUNT = 150;
  const contentPaths = Array.from({ length: COUNT }, (_, i) => `files/f_${i}.enc`);
  const indexPaths = Array.from({ length: COUNT }, (_, i) => `links/l_${i}.enc`);
  // That many ops is slow here for the fake, not the engine: fake-indexeddb drops a
  // record's old index entries by scanning the whole index, so every write is O(n)
  // and a case is O(n²) — 1–3s alone, past jest's 5s default under a parallel
  // `npm run test`. A timed-out case is not stopped either: its sync runs on into
  // the next one and commits there, failing that case too.
  const SLOW_MS = 30_000;
  const slowIt = (name: string, fn: () => Promise<void>) => it(name, fn, SLOW_MS);

  beforeEach(async () => {
    for (const path of [...contentPaths, ...indexPaths]) await seedQueued(path, 'bytes');
  }, SLOW_MS);

  slowIt('commits content in smaller chunks than the index', async () => {
    await runIncrementalSync(deps({ opsList: quietLog }));

    const isContent = (batch: { path: string }[]) => batch[0].path.startsWith('files/');
    const contentCommits = commits.filter(isContent);
    const indexCommits = commits.filter((b) => !isContent(b));
    expect(indexCommits).toHaveLength(1);
    expect(contentCommits.length).toBeGreaterThan(1);
    // Every op still went up, content first — the phase order holds across chunks.
    expect(commits.at(-1)).toBe(indexCommits[0]);
    expect(committedPaths().sort()).toEqual([...contentPaths, ...indexPaths].sort());
    expect(await pendingPaths()).toEqual([]);
  });

  slowIt('asks the quota gate once, and counts every op it refused or held', async () => {
    // The gate refuses on the account's usage, never on which paths a chunk holds,
    // so asking again for each remaining content chunk only spends the rate limit
    // on an answer already known — and the metadata phase is held behind refused
    // content, unasked. The count must still cover all of them, or the "N changes
    // aren't syncing" line understates what is stuck.
    const putSigns: number[] = [];
    const outcome = await runIncrementalSync(
      deps({
        opsList: quietLog,
        filesSign: (paths, op) => {
          if (op !== 'put') return;
          putSigns.push(paths.length);
          throw QUOTA_EXCEEDED;
        },
      }),
    );

    // One content chunk refused — not one per chunk, and no index chunk after it.
    expect(putSigns).toHaveLength(1);
    expect(outcome.blockedCount).toBe(2 * COUNT);
    expect(committedPaths()).toEqual([]);
    expect(await pendingPaths()).toHaveLength(2 * COUNT);
  });

  slowIt('clears each chunk from the queue before it signs the next', async () => {
    // The whole point of a smaller content chunk: the pending count steps down per
    // chunk, not once per phase. A pass that signed ahead, or held its commits to
    // the end of the phase, would show the count frozen across every sign.
    const signs: { size: number; pendingBefore: number }[] = [];
    await runIncrementalSync(
      deps({
        opsList: quietLog,
        filesSign: async (paths, op) => {
          if (op !== 'put') return;
          signs.push({ size: paths.length, pendingBefore: (await pendingPaths()).length });
        },
      }),
    );

    expect(signs.length).toBeGreaterThan(2);
    expect(signs[0].pendingBefore).toBe(2 * COUNT);
    for (let i = 1; i < signs.length; i++) {
      expect(signs[i].pendingBefore).toBe(signs[i - 1].pendingBefore - signs[i - 1].size);
    }
  });

  slowIt('keeps what it pushed before a mid-phase refusal, and counts only the rest', async () => {
    // A refusal past the first chunk: the chunks before it are committed and off the
    // queue, so counting them as blocked would overstate what is stuck.
    const putSigns: number[] = [];
    const outcome = await runIncrementalSync(
      deps({
        opsList: quietLog,
        filesSign: (paths, op) => {
          if (op !== 'put') return;
          putSigns.push(paths.length);
          if (putSigns.length > 1) throw QUOTA_EXCEEDED;
        },
      }),
    );

    const [pushed] = putSigns;
    // Granted, then refused — neither the rest of the content phase nor the held
    // metadata phase is asked.
    expect(putSigns).toHaveLength(2);
    expect(committedPaths()).toHaveLength(pushed);
    expect(committedPaths().every((p) => p.startsWith('files/'))).toBe(true);
    expect(outcome.blockedCount).toBe(2 * COUNT - pushed);
    expect(await pendingPaths()).toHaveLength(2 * COUNT - pushed);
  });
});

// --- the path each blob is bound to ----------------------------------------------

// A blob opens only under the sync path it was sealed for (shared
// crypto/blob-aad.ts). The crypto is a stand-in in this file, so what is pinned
// here is the engine's half: every seal names the path the blob is PUT to, and
// every open the path it was fetched from. A wrong path is not caught by any
// round trip here — the stand-in ignores it — and on a device it fails every
// download of that blob, on every other client.
describe('the path each blob is sealed for and opened under', () => {
  const pathArg = (mock: jest.Mock) => mock.mock.calls.map((call) => call[2]);

  it('seals a pushed blob for the path it is PUT to', async () => {
    await seedQueued(LINK_PATH, 'the link');

    await runIncrementalSync(deps());

    expect(pathArg(encryptEntity as jest.Mock)).toEqual([LINK_PATH]);
  });

  it('opens a pulled blob under the path it was listed at, each entry of a page under its own', async () => {
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('new')]));

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

    expect(pathArg(decryptEntity as jest.Mock).sort()).toEqual([LINK_PATH, OTHER_LINK_PATH]);
  });

  it('opens fetched content under its own path, one at a time and in a batch', async () => {
    await db.items.put(toItemRecord(FILE_PATH, 1000));
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('page copy')]));

    await loadEntityContent(deps(), FILE_PATH);
    expect(pathArg(decryptEntity as jest.Mock)).toEqual([FILE_PATH]);

    // Two distinct paths in one batch, so opening every item under the first
    // one's path would show.
    (decryptEntity as jest.Mock).mockClear();
    await db.items.put(toItemRecord(FILE_PATH, 1000));
    await db.items.put(toItemRecord(OTHER_FILE_PATH, 1000));
    await loadEntityContents(deps(), [FILE_PATH, OTHER_FILE_PATH]);

    expect(pathArg(decryptEntity as jest.Mock).sort()).toEqual([FILE_PATH, OTHER_FILE_PATH]);
  });
});

// One pulled blob that does not open under its path — tampered, sealed for another path,
// from a build before the binding — used to reject the pull, so the cycle failed with the
// cursor where it was and met the same blob on every cycle after: no path in the account
// synced again. It is skipped like a mid-pull 404 now. An UNKNOWN format version is not
// skipped: an update reads it, and skipping would move the cursor past it for good.
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
    failToOpen(LINK_PATH, new BlobUnreadableError(LINK_PATH));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await runIncrementalSync(deps({ opsList: () => TWO_PUTS }));
    } finally {
      warn.mockRestore();
    }

    expect(await db.items.get(LINK_PATH)).toBeUndefined();
    expect(await bodyAt(OTHER_LINK_PATH)).toBe(`server ${OTHER_LINK_PATH}`);
    expect((await getSyncMeta(USER))?.syncCursorUpdatedAt).toBe(2001);
  });

  // What the device already held for the path is not the server's to take away by
  // serving something that does not open.
  it('leaves the local copy of that path as it was', async () => {
    await seedSynced(LINK_PATH, 'held here', 1000);
    failToOpen(LINK_PATH, new BlobUnreadableError(LINK_PATH));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await runIncrementalSync(deps({ opsList: () => TWO_PUTS }));
    } finally {
      warn.mockRestore();
    }

    expect(await bodyAt(LINK_PATH)).toBe('held here');
  });

  it('still fails the cycle on anything else, an unknown version above all', async () => {
    failToOpen(LINK_PATH, new Error('Unknown blob format version: 2'));

    await expect(runIncrementalSync(deps({ opsList: () => TWO_PUTS }))).rejects.toThrow(
      'Unknown blob format version: 2',
    );

    expect((await getSyncMeta(USER))?.syncCursorUpdatedAt).toBe(1000);
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

// The batch fetch's own poison pill. One `files/` blob that does not open under its
// path rejected the whole batch, and every caller reads a rejection as a dead network:
// the export failed on every attempt, for every file in the library, and the content
// provider forgot the batch and asked for all of it again on the next mount. It is
// reported missing now, like a 404 — the export counts it as a file it could not
// include, and the rest of the batch lands.
describe('a fetched content blob that does not open under its path', () => {
  afterEach(() => {
    mockGetBlob.mockReset();
    (decryptEntity as jest.Mock).mockImplementation(async (_key: unknown, bytes: Uint8Array) =>
      bytes.slice(1),
    );
  });

  it('is reported missing, and the rest of the batch lands', async () => {
    await db.items.put(toItemRecord(FILE_PATH, 1000));
    await db.items.put(toItemRecord(OTHER_FILE_PATH, 1000));
    mockGetBlob.mockImplementation(async (url: string) =>
      Promise.resolve(new Uint8Array([0xee, ...utf8(`server ${pathFor(url)}`)])),
    );
    (decryptEntity as jest.Mock).mockImplementation(
      async (_key: unknown, bytes: Uint8Array, at: string) => {
        if (at === FILE_PATH) throw new BlobUnreadableError(FILE_PATH);
        return bytes.slice(1);
      },
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    let result: { missingPaths: string[] };
    try {
      result = await loadEntityContents(deps(), [FILE_PATH, OTHER_FILE_PATH]);
    } finally {
      warn.mockRestore();
    }

    expect(result.missingPaths).toEqual([FILE_PATH]);
    expect(await bodyAt(FILE_PATH)).toBeUndefined();
    expect(await bodyAt(OTHER_FILE_PATH)).toBe(`server ${OTHER_FILE_PATH}`);
  });

  it('still rejects on anything else, an unknown version above all', async () => {
    await db.items.put(toItemRecord(FILE_PATH, 1000));
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('page copy')]));
    (decryptEntity as jest.Mock).mockRejectedValue(new Error('Unknown blob format version: 2'));

    await expect(loadEntityContents(deps(), [FILE_PATH])).rejects.toThrow(
      'Unknown blob format version: 2',
    );
  });
});

// The export's file phase runs best-effort. It took this function's default —
// every transport failure rejects — and so an export with even one image not yet
// on this device failed outright offline, after its sync step had already been
// let off with a warning. The default stays: the content provider remembers
// `missingPaths` for the session and retries only on a rejection, so a dead
// network reported as missing would hide those images until the next launch.
describe('loadEntityContents, best-effort', () => {
  afterEach(() => mockGetBlob.mockReset());

  async function seedBoth(): Promise<void> {
    await db.items.put(toItemRecord(FILE_PATH, 1000));
    await db.items.put(toItemRecord(OTHER_FILE_PATH, 1000));
  }

  it('fails one path on a transport error, and the rest of the batch lands', async () => {
    await seedBoth();
    mockGetBlob.mockImplementation(async (url: string) => {
      if (pathFor(url) === FILE_PATH) throw new BlobRequestError('GET', 503);
      return new Uint8Array([0xee, ...utf8(`server ${pathFor(url)}`)]);
    });

    const result = await loadEntityContents(deps(), [FILE_PATH, OTHER_FILE_PATH], undefined, {
      bestEffort: true,
    });

    expect(result).toEqual({ missingPaths: [], failedPaths: [FILE_PATH] });
    expect(await bodyAt(FILE_PATH)).toBeUndefined();
    expect(await bodyAt(OTHER_FILE_PATH)).toBe(`server ${OTHER_FILE_PATH}`);
  });

  it('fails every path when the sign call fails, and fetches nothing', async () => {
    await seedBoth();
    const progress = jest.fn();

    const result = await loadEntityContents(
      deps({
        filesSign: () => {
          throw new ApiTimeoutError(60_000);
        },
      }),
      [FILE_PATH, OTHER_FILE_PATH],
      progress,
      { bestEffort: true },
    );

    expect(result).toEqual({ missingPaths: [], failedPaths: [FILE_PATH, OTHER_FILE_PATH] });
    expect(mockGetBlob).not.toHaveBeenCalled();
    // The export's progress bar reaches its end rather than stopping at 0 of 2.
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });

  // The device is being told to forget, and the caller is about to write the
  // library out to a file.
  it('still rejects on session_revoked', async () => {
    await seedBoth();
    const revoked = new ApiError(401, JSON.stringify({ error: 'session_revoked' }));

    await expect(
      loadEntityContents(
        deps({
          filesSign: () => {
            throw revoked;
          },
        }),
        [FILE_PATH],
        undefined,
        { bestEffort: true },
      ),
    ).rejects.toBe(revoked);
  });

  it('rejects on a transport error without it, which is the content provider’s signal', async () => {
    await seedBoth();
    mockGetBlob.mockRejectedValue(new BlobRequestError('GET', 503));

    await expect(loadEntityContents(deps(), [FILE_PATH])).rejects.toBeInstanceOf(BlobRequestError);
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
    await beginInitialSync(USER);
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

// --- the account fence -------------------------------------------------------

// A cycle is many round trips long, and a sign-out, a revocation wipe or an account
// switch can land in ANY context sharing this database while it's on the network
// (docs/sessions.md, _concurrent requests and shared local state_). What it pulls
// after that is the OLD account's plaintext, and the store it would write into is
// empty — or already the next account's. Every pulled write re-checks, inside its own
// transaction, that the account still owns the store (sync-store.ts).
describe('a cycle that outlives its account', () => {
  // The teardown's own writes (clear-data.ts), landed from inside a stub handler so it
  // falls after the cycle started and before it applies anything.
  const tearDown = () =>
    Promise.all([db.items.clear(), db.pendingOps.clear(), db.syncMeta.clear()]);

  beforeEach(() => {
    mockGetBlob.mockImplementation(async () => new Uint8Array([0xee, ...utf8('server copy')]));
  });

  it('writes nothing into the store once the account is torn down mid-cycle', async () => {
    const cycle = runIncrementalSync(
      deps({
        opsList: async () => {
          await tearDown();
          return {
            ops: [{ op: 'put', path: LINK_PATH, updatedAt: 2000 }],
            oldestUpdatedAt: 500,
            newestUpdatedAt: 2000,
            hasMore: false,
          };
        },
      }),
    );

    await expect(cycle).rejects.toBeInstanceOf(AccountFencedError);
    expect(await db.items.count()).toBe(0);
    // …and the bookkeeping row isn't resurrected by the cursor write either.
    expect(await db.syncMeta.count()).toBe(0);
  });

  it('cannot finish a first sync for an account torn down mid-pull', async () => {
    await db.syncMeta.clear();
    await beginInitialSync(USER);

    const pull = runInitialSync(
      deps({
        filesList: async () => {
          await tearDown();
          return [{ path: LINK_PATH, updatedAt: 2000 }];
        },
      }),
    );

    await expect(pull).rejects.toBeInstanceOf(AccountFencedError);
    expect(await db.items.count()).toBe(0);
    expect(await db.syncMeta.count()).toBe(0);
  });

  // The control: the fence must not stop a first sync that nobody interrupted.
  it('lets an uninterrupted first sync through', async () => {
    await db.syncMeta.clear();
    await beginInitialSync(USER);

    await runInitialSync(deps({ filesList: () => [{ path: LINK_PATH, updatedAt: 2000 }] }));

    expect(await bodyAt(LINK_PATH)).toBe('server copy');
    expect((await db.syncMeta.get(USER))?.firstSyncDoneAt).toBeGreaterThan(0);
  });

  it('cannot recreate ownership when an old first sync starts after teardown', async () => {
    await tearDown();
    await expect(runInitialSync(deps({ filesList: () => [] }))).rejects.toBeInstanceOf(
      AccountFencedError,
    );
    expect(await db.syncMeta.count()).toBe(0);
  });
});

// --- a server that remembers -------------------------------------------------

// The stub above answers ops/list with whatever a case hands it and stamps every
// commit alike — all a mid-cycle write needs, and deliberately no more. The cases
// below are about the CURSOR, and a cursor is a statement about the server's
// ordering, so they need a server that keeps its side of it. Three properties, each
// the real one in miniature:
//
//  - the pull is a keyset on `(updatedAt, path)` and reports the retained bounds
//    (bracemark-api do/repositories/op-logs.ts) — a stub that returns the same ops
//    whatever cursor it is asked for cannot show an op being skipped;
//  - a commit is stamped `MAX(updated_at) + 1` when its own stamp is not already
//    past the log (the clamp, do/user-data.ts) — which is what puts THIS client's
//    commit above one another client made a moment earlier;
//  - R2 lists in key order, a page per call, reading the bucket as it is at that
//    call — so an object written into a range already listed is simply not there.
//
// One clock stamps both R2's `LastModified` and the Worker's commit time, as under
// `wrangler dev`.
class SyncServer {
  private clock = 5_000_000;
  readonly objects = new Map<string, { body: Uint8Array; uploaded: number }>();
  readonly log: { op: 'put' | 'delete'; path: string; updatedAt: number }[] = [];

  private tick(): number {
    this.clock += 10;
    return this.clock;
  }

  put(path: string, body: Uint8Array): void {
    this.objects.set(path, { body, uploaded: this.tick() });
  }

  get(path: string): Uint8Array {
    const object = this.objects.get(path);
    if (!object) throw new BlobRequestError('GET', 404);
    return object.body;
  }

  // The plaintext the server holds for a path, through the stand-in cipher.
  body(path: string): string | undefined {
    const object = this.objects.get(path);
    return object ? new TextDecoder().decode(object.body.slice(1)) : undefined;
  }

  bounds(): { oldestUpdatedAt: number | null; newestUpdatedAt: number | null } {
    if (this.log.length === 0) return { oldestUpdatedAt: null, newestUpdatedAt: null };
    const stamps = this.log.map((row) => row.updatedAt);
    return { oldestUpdatedAt: Math.min(...stamps), newestUpdatedAt: Math.max(...stamps) };
  }

  listOps(since: number, sincePath: string, limit: number): OpsListReply {
    const rows = this.log
      .filter((row) => row.updatedAt > since || (row.updatedAt === since && row.path > sincePath))
      .sort((a, b) => a.updatedAt - b.updatedAt || (a.path < b.path ? -1 : 1));
    return { ops: rows.slice(0, limit), ...this.bounds(), hasMore: rows.length > limit };
  }

  commit(ops: { op: 'put' | 'delete'; path: string }[]) {
    const now = this.tick();
    for (const o of ops) if (o.op === 'delete') this.objects.delete(o.path);
    const failed: { path: string; reason: 'no_object' }[] = [];
    const entries: { op: 'put' | 'delete'; path: string; updatedAt: number }[] = [];
    for (const o of ops) {
      const object = this.objects.get(o.path);
      if (o.op === 'delete') entries.push({ ...o, updatedAt: now });
      else if (!object) failed.push({ path: o.path, reason: 'no_object' });
      else entries.push({ ...o, updatedAt: object.uploaded });
    }
    const { newestUpdatedAt } = this.bounds();
    const floor = newestUpdatedAt === null ? 0 : newestUpdatedAt + 1;
    const results = entries.map((entry) => {
      const updatedAt = Math.max(entry.updatedAt, floor);
      this.log.push({ op: entry.op, path: entry.path, updatedAt });
      return { path: entry.path, updatedAt };
    });
    return { results, failed };
  }

  listFiles(pageToken: string | undefined, pageSize: number) {
    const keys = [...this.objects.keys()].sort().filter((key) => !pageToken || key > pageToken);
    const page = keys.slice(0, pageSize);
    return {
      files: page.map((path) => ({ path, updatedAt: this.objects.get(path)?.uploaded ?? 0 })),
      nextPageToken: keys.length > pageSize ? page[page.length - 1] : null,
    };
  }

  // ANOTHER client of the same account — a second device, or the browser extension
  // beside the web app: its PUT, then its commit. Returns the stamp it was given.
  otherClientPuts(path: string, body: string): number {
    this.put(path, new Uint8Array([0xee, ...utf8(body)]));
    return this.commit([{ op: 'put', path }]).results[0].updatedAt;
  }

  // …and its delete: the commit removes the object and logs the op, as the api does.
  otherClientDeletes(path: string): number {
    return this.commit([{ op: 'delete', path }]).results[0].updatedAt;
  }
}

interface ServerHooks {
  // Runs when this client asks for PUT urls: after its list, before its commit —
  // the window another client's commit has to land in.
  beforePush?: () => void | Promise<void>;
  // Runs after each `files/list` page was read off the bucket.
  afterFilesPage?: (page: number) => void | Promise<void>;
  // The same two for the op log: the page size the server answers with (fewer
  // than asked is a legal answer, and `hasMore` says so), and a hook that runs
  // after each page was read off the log.
  opsPageSize?: number;
  afterOpsPage?: (page: number) => void | Promise<void>;
  // The page size the server answers with, whatever the client asked for — R2 may
  // return fewer than `limit`, and a small one makes a small library page.
  filesPageSize?: number;
}

// A client of `server`, with a record of what it asked for. The endpoints are
// matched by their `path` rather than by identity: a second tab (below) is a second
// copy of every module, `@stxapps/shared` included, and its endpoint objects are
// equal to these without being them.
function onServer(
  server: SyncServer,
  hooks: ServerHooks = {},
  username = USER,
): { deps: SyncDeps; calls: string[] } {
  const calls: string[] = [];
  const is = (endpoint: unknown, known: { path: string }): boolean =>
    (endpoint as { path?: string }).path === known.path;
  let filesPage = 0;
  let opsPage = 0;
  const api = {
    call: async (endpoint: unknown, input: Record<string, unknown>) => {
      if (is(endpoint, opsListEndpoint)) {
        calls.push('ops/list');
        const reply = server.listOps(
          (input.since as number | undefined) ?? 0,
          (input.sincePath as string | undefined) ?? '',
          hooks.opsPageSize ?? (input.limit as number),
        );
        await hooks.afterOpsPage?.(++opsPage);
        return reply;
      }
      if (is(endpoint, filesListEndpoint)) {
        calls.push('files/list');
        const page = server.listFiles(
          input.pageToken as string | undefined,
          hooks.filesPageSize ?? (input.limit as number),
        );
        await hooks.afterFilesPage?.(++filesPage);
        return page;
      }
      if (is(endpoint, filesSignEndpoint)) {
        calls.push(`files/sign ${String(input.op)}`);
        if (input.op === 'put') await hooks.beforePush?.();
        return { urls: (input.paths as string[]).map((path) => ({ path, url: urlFor(path) })) };
      }
      if (is(endpoint, opsCommitEndpoint)) {
        calls.push('ops/commit');
        return server.commit(input.ops as { op: 'put' | 'delete'; path: string }[]);
      }
      throw new Error('unexpected endpoint');
    },
  } as unknown as SyncDeps['api'];
  return { deps: { username, encryptionKey: {} as CryptoKey, api }, calls };
}

// Point this file's R2 movers at `server`, so a PUT is an object it then lists,
// HEADs at commit and serves back.
function r2On(server: SyncServer): void {
  mockPutBlob.mockImplementation(async (url: string, body: Uint8Array) => {
    server.put(pathFor(url), body);
  });
  mockGetBlob.mockImplementation(async (url: string) => server.get(pathFor(url)));
}

// This device, in sync with a server that already holds one committed link: the
// record is stored at its stamp and the cursor sits on its op.
const BASE_PATH = 'links/l_base.enc';
async function inSyncWith(server: SyncServer, username = USER): Promise<number> {
  const stamp = server.log.at(-1)?.updatedAt ?? server.otherClientPuts(BASE_PATH, 'base');
  await db.items.put(toItemRecord(BASE_PATH, stamp, utf8('base')));
  await db.syncMeta.put({
    username,
    syncCursorUpdatedAt: stamp,
    syncCursorPath: BASE_PATH,
    firstSyncDoneAt: 1,
  });
  return stamp;
}

async function cursor(): Promise<[number, string]> {
  const meta = await db.syncMeta.get(USER);
  return [meta?.syncCursorUpdatedAt ?? NaN, meta?.syncCursorPath ?? ''];
}

// --- the cursor --------------------------------------------------------------

// The cursor is the claim "every op at or below this point has been applied here",
// and it used to be written from two things that were never read: this cycle's OWN
// commits (which the clamp stamps above an op another client committed a moment
// before), and the newest stamp a paged R2 listing happened to show (which says
// nothing about an object written into a range the listing had already passed).
// Either way another client's op ended up below the cursor, where a keyset pull
// never returns it — a link saved on the phone that never appears on the laptop,
// with the cycle complete, the queue drained and the cursor inside the log's range,
// so no error, no pending count and no fallback. Two devices merely in use at the
// same time lost links to each other this way without any forced timing
// (docs/local-first-sync.md, _the cursor is a claim_).
describe('the cursor claims only what a cycle read', () => {
  let server: SyncServer;
  beforeEach(() => {
    server = new SyncServer();
    r2On(server);
  });

  it('pulls an op another client committed between its list and its own commit', async () => {
    await inSyncWith(server);
    await seedQueued(LINK_PATH, 'saved here');

    await runIncrementalSync(
      onServer(server, {
        beforePush: () => void server.otherClientPuts(OTHER_LINK_PATH, 'saved on the phone'),
      }).deps,
    );
    // Any ordinary later cycle is this device's chance to receive it.
    await runIncrementalSync(onServer(server).deps);

    expect(await bodyAt(OTHER_LINK_PATH)).toBe('saved on the phone');
  });

  it('pulls one committed between a fallback’s listing and its push', async () => {
    // A brand-new account: `(0, '')` against an empty log, so its first push is a
    // fallback — and that cycle folded its own commit into the cursor too.
    await db.syncMeta.put({
      username: USER,
      syncCursorUpdatedAt: 0,
      syncCursorPath: '',
      firstSyncDoneAt: 1,
    });
    await seedQueued(LINK_PATH, 'saved here');

    await runIncrementalSync(
      onServer(server, {
        beforePush: () => void server.otherClientPuts(OTHER_LINK_PATH, 'saved on the phone'),
      }).deps,
    );
    await runIncrementalSync(onServer(server).deps);

    expect(await bodyAt(OTHER_LINK_PATH)).toBe('saved on the phone');
  });

  it('pulls an object written into a key range a first sync’s listing had already passed', async () => {
    for (const id of ['l_m1', 'l_m2', 'l_m3', 'l_m4']) {
      server.otherClientPuts(`links/${id}.enc`, id);
    }
    await db.syncMeta.clear();
    await beginInitialSync(USER);

    await runInitialSync(
      onServer(server, {
        filesPageSize: 2,
        // After page one ([l_m1, l_m2]) another device saves two links: `l_a` sorts
        // BEFORE everything listed so far, `l_z` into a page still to come. The
        // listing then shows `l_z`, the newer of the two, and never shows `l_a`.
        afterFilesPage: (page) => {
          if (page !== 1) return;
          server.otherClientPuts(LINK_PATH, 'landed behind the listing');
          server.otherClientPuts('links/l_z.enc', 'landed ahead of it');
        },
      }).deps,
    );
    // The provider kicks a cycle the moment a first sync is done.
    await runIncrementalSync(onServer(server).deps);

    expect(await bodyAt('links/l_z.enc')).toBe('landed ahead of it');
    expect(await bodyAt(LINK_PATH)).toBe('landed behind the listing');
  });

  it('drops what another device deleted between an interrupted first sync and its re-run', async () => {
    // A first sync only ever ADDED: it assumed the empty store of a fresh sign-in.
    // But a pull that dies partway — a dropped connection, a closed tab — leaves
    // what it had stored, and the retry lists a namespace that may have lost some of
    // it since. That link is in the store and not in the listing, and its delete op
    // was committed before the retry read the log's high-water mark — so it is at or
    // below the cursor the retry ends on, and no later pull ever returns it.
    const stored = server.otherClientPuts('links/l_m1.enc', 'l_m1');
    server.otherClientPuts('links/l_m2.enc', 'l_m2');
    await db.syncMeta.clear();
    await beginInitialSync(USER);
    // What the interrupted attempt left behind: one link stored, the flag not set.
    await seedSynced('links/l_m1.enc', 'l_m1', stored);

    // Before the retry, another device deletes that link — and then saves one, so
    // the delete is not the newest thing in the log (an op stamped exactly on the
    // high-water mark is replayed, and would hide this).
    server.otherClientDeletes('links/l_m1.enc');
    server.otherClientPuts(LINK_PATH, 'saved since');

    await runInitialSync(onServer(server).deps);
    await runIncrementalSync(onServer(server).deps);

    expect(await db.items.get('links/l_m1.enc')).toBeUndefined();
    // The control: the retry still did the rest of its job.
    expect(await bodyAt('links/l_m2.enc')).toBe('l_m2');
    expect(await bodyAt(LINK_PATH)).toBe('saved since');
  });

  it('keeps, on that re-run, a link saved here that the server has never seen', async () => {
    // The control. "In the store and not in the listing" also describes a link
    // this device saved and has not pushed — the browser extension can save one
    // before its first sync has finished — and the re-run must tell the two apart
    // the way every reconcile does: by the queue, re-read when the delete applies.
    server.otherClientPuts('links/l_m1.enc', 'l_m1');
    await db.syncMeta.clear();
    await beginInitialSync(USER);
    await seedQueued(LINK_PATH, 'saved here, not pushed');

    await runInitialSync(onServer(server).deps);

    expect(await bodyAt(LINK_PATH)).toBe('saved here, not pushed');
    expect(await pendingPaths()).toEqual([LINK_PATH]);
    // …and the cycle the provider kicks next pushes it.
    await runIncrementalSync(onServer(server).deps);
    expect(server.body(LINK_PATH)).toBe('saved here, not pushed');
    expect(await pendingPaths()).toEqual([]);
  });

  it('pages through the op log, and lists a commit that lands between two pages', async () => {
    // "The last op a cycle listed" is computed HERE: the pull pages by keyset,
    // each page asked for from the last op of the one before, and the cursor ends
    // wherever the last page did. A commit that lands mid-pull is stamped above
    // everything the earlier pages showed, so the page still to come carries it —
    // which is the whole of why it is safe to stop at "the newest op in the
    // response" rather than asking the server what its newest is.
    await inSyncWith(server);
    for (const id of ['l_p1', 'l_p2', 'l_p3']) server.otherClientPuts(`links/${id}.enc`, id);

    const client = onServer(server, {
      opsPageSize: 2,
      afterOpsPage: (page) => {
        if (page === 1) server.otherClientPuts(LINK_PATH, 'landed mid-pull');
      },
    });
    await runIncrementalSync(client.deps);

    expect(client.calls.filter((call) => call === 'ops/list')).toHaveLength(2);
    for (const id of ['l_p1', 'l_p2', 'l_p3']) expect(await bodyAt(`links/${id}.enc`)).toBe(id);
    expect(await bodyAt(LINK_PATH)).toBe('landed mid-pull');
    expect((await cursor())[1]).toBe(LINK_PATH);

    // And the claim is whole: the next cycle has nothing left to fetch.
    mockGetBlob.mockClear();
    await runIncrementalSync(onServer(server).deps);
    expect(mockGetBlob).not.toHaveBeenCalled();
  });

  it('moves a selective client’s cursor over ops it does not materialize', async () => {
    // The browser extension stores only some namespaces (`pathFilter`). The filter
    // is on DOWNLOADS: the cursor still has to pass every op listed, or each cycle
    // would list the unwanted ones again for good — and a delete still applies.
    const stamp = await inSyncWith(server);
    await seedSynced(OTHER_LINK_PATH, 'deleted elsewhere', stamp);
    server.otherClientPuts(LINK_PATH, 'a link');
    server.otherClientDeletes(OTHER_LINK_PATH);
    server.otherClientPuts('tags/t_a.enc', 'a tag');
    const selective = (client: { deps: SyncDeps; calls: string[] }) => ({
      ...client.deps,
      pathFilter: (path: string) => path.startsWith('links/'),
    });

    await runIncrementalSync(selective(onServer(server)));

    expect(await bodyAt(LINK_PATH)).toBe('a link');
    expect(await db.items.get(OTHER_LINK_PATH)).toBeUndefined();
    expect(await db.items.get('tags/t_a.enc')).toBeUndefined();
    expect(mockGetBlob.mock.calls.map(([url]) => pathFor(url))).toEqual([LINK_PATH]);
    // Past the tag it never fetched.
    expect((await cursor())[1]).toBe('tags/t_a.enc');
  });

  // The other half of the same change: what stopping the cursor short of our own
  // commits costs. An op row each, and nothing else.
  it('lists its own commit back at the cost of an op row, not a download', async () => {
    const base = await inSyncWith(server);
    await seedQueued(LINK_PATH, 'saved here');

    await runIncrementalSync(onServer(server).deps);
    // Nothing was listed, so nothing was claimed — the push moved no cursor.
    expect(await cursor()).toEqual([base, BASE_PATH]);

    await runIncrementalSync(onServer(server).deps);
    // Now it has been listed: the cursor is on our own op, and recognising it took
    // no GET.
    expect((await cursor())[1]).toBe(LINK_PATH);
    expect(mockGetBlob).not.toHaveBeenCalled();
    expect(await bodyAt(LINK_PATH)).toBe('saved here');
    expect(await pendingPaths()).toEqual([]);
  });

  it('recognises the echo of a content push without reading the cached blob', async () => {
    // A content record's `data` IS the blob. Reading a batch of them to compare
    // stamps would pull every page copy this device just uploaded into memory at
    // once, to learn that nothing changed.
    await inSyncWith(server);
    await seedQueued(FILE_PATH, 'megabytes of page copy');
    await runIncrementalSync(onServer(server).deps);

    const read = jest.spyOn(db.items, 'bulkGet');
    try {
      await runIncrementalSync(onServer(server).deps);
      expect(read.mock.calls.flatMap(([paths]) => paths)).not.toContain(FILE_PATH);
    } finally {
      read.mockRestore();
    }
    // …and it was the echo that was recognised, not the cursor that skipped it.
    expect((await cursor())[1]).toBe(FILE_PATH);
    expect(await bodyAt(FILE_PATH)).toBe('megabytes of page copy');
  });

  it('still lowers a cursor that is ahead of a reset log', async () => {
    // The one thing a listing-built cursor has to keep doing: a log restored from
    // an older state sits BELOW a cursor it once issued, and the fallback has to
    // bring the cursor back down to it rather than leave it pointing past the log.
    const newest = server.otherClientPuts(BASE_PATH, 'base');
    await db.syncMeta.put({
      username: USER,
      syncCursorUpdatedAt: newest + 1_000_000,
      syncCursorPath: 'links/l_gone.enc',
      firstSyncDoneAt: 1,
    });

    const { deps: client, calls } = onServer(server);
    await runIncrementalSync(client);

    expect(calls).toContain('files/list');
    expect(await cursor()).toEqual([newest, '']);
    expect(await bodyAt(BASE_PATH)).toBe('base');
  });

  it('takes one more listing, then pulls incrementally, once an empty log has its first commit', async () => {
    // What ending a fallback on the log's high-water mark costs a brand-new
    // account: with nothing in the log there is no mark to end on, so the cursor
    // stays at the beginning and the cycle after the first commit lists once more.
    // Pinned so that stays ONE listing — a cursor that never left `(0, '')` would
    // re-list the whole library on every cycle for the life of the account.
    await db.syncMeta.put({
      username: USER,
      syncCursorUpdatedAt: 0,
      syncCursorPath: '',
      firstSyncDoneAt: 1,
    });

    await seedQueued(LINK_PATH, 'first');
    await runIncrementalSync(onServer(server).deps);
    expect(await cursor()).toEqual([0, '']);

    await seedQueued(OTHER_LINK_PATH, 'second');
    const second = onServer(server);
    await runIncrementalSync(second.deps);
    expect(second.calls).toContain('files/list');

    await seedQueued(SETTINGS_PATH, 'third');
    const third = onServer(server);
    await runIncrementalSync(third.deps);
    expect(third.calls).not.toContain('files/list');
    expect(await pendingPaths()).toEqual([]);
  });
});

// --- two tabs ----------------------------------------------------------------

// Single-flight is module state, and every tab of the web app loads its own copy of
// the module over the SAME database: two tabs were two drains of one queue. With
// tab A's upload of an edit still in flight, the link was edited again and tab B —
// a whole cycle, start to finish — pushed the newer bytes, committed, restamped
// and cleared. Then A's upload landed on top. The server kept the EARLIER of two
// edits made on this device, the local store kept the later, the queue was empty
// and the indicator read idle; a fallback compares stamps, not bytes, so nothing
// repaired it either. The same overlap let a stale upload bring back a link the
// other tab had deleted for good, and a pulled delete remove a link the other tab
// had just pushed an edit to (docs/local-first-sync.md, _two tabs, one queue_).
//
// A second tab here is what it is in the browser where it matters: a second copy
// of the engine (so its own single-flight slot) and of the store module (its own
// connection to the one database). The R2 movers are not a second copy — jest
// hands an isolated registry the SAME `./r2` mock — so both tabs' transfers reach
// one stub and a hold placed on it holds either tab's. The tab's movers are
// pointed at the server through its own handle anyway, so nothing here rests on
// that.
describe('two tabs, one queue', () => {
  interface Tab {
    engine: typeof import('./engine');
    r2: jest.Mocked<typeof import('./r2')>;
    close: () => void;
  }

  function openSecondTab(server: SyncServer): Tab {
    let tab!: Tab;
    jest.isolateModules(() => {
      const engine = require('./engine') as typeof import('./engine');
      const r2 = require('./r2') as jest.Mocked<typeof import('./r2')>;
      const data = require('../data/db') as typeof import('../data/db');
      tab = { engine, r2, close: () => data.db.close() };
    });
    tab.r2.putBlob.mockImplementation(async (url: string, body: Uint8Array) => {
      server.put(pathFor(url), body);
    });
    tab.r2.getBlob.mockImplementation(async (url: string) => server.get(pathFor(url)));
    return tab;
  }

  // "Did the other tab's cycle wait?" is asked of the lock, not of a clock. A
  // pause long enough for a free cycle to have run is a guess about the machine:
  // under a loaded run it is too short, and then a cycle that DID wait and one that
  // simply had not started yet look the same. The origin keeps the queue itself.
  //
  // True once a cycle of `username`'s is queued behind the cycle lock; false if
  // none is within the budget — which is the answer on an engine that takes no
  // lock, and still returns, so the case can let tab A finish before it fails.
  const BUDGET_MS = 3_000;
  async function within(what: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + BUDGET_MS;
    for (;;) {
      if (await what()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  const queuedBehindLock = (username = USER): Promise<boolean> =>
    within(async () => {
      const { pending = [] } = await navigator.locks.query();
      // By account, not by the lock's full name: the name is the engine's to pick.
      return pending.some((lock) => lock.name?.endsWith(`:${username}`));
    });

  // Tab A's cycle, stopped with its PUT in flight: it has read and encrypted the
  // bytes, and the object has not landed.
  function holdTabAUpload(server: SyncServer): { uploading: Promise<void>; land: () => void } {
    let started!: () => void;
    let land!: () => void;
    const uploading = new Promise<void>((resolve) => (started = resolve));
    const held = new Promise<void>((resolve) => (land = resolve));
    mockPutBlob.mockImplementation(async (url: string, body: Uint8Array) => {
      started();
      await held;
      server.put(pathFor(url), body);
    });
    return { uploading, land };
  }

  let server: SyncServer;
  let tabB: Tab;
  beforeEach(() => {
    // The claim below is about a lock every context of the origin shares, so it
    // has to be the real thing that is shared here too.
    expect(typeof navigator.locks?.request).toBe('function');
    server = new SyncServer();
    r2On(server);
    tabB = openSecondTab(server);
  });
  afterEach(() => tabB.close());

  it('makes the second tab’s cycle wait, so the later edit is the one the server keeps', async () => {
    await inSyncWith(server);
    await seedQueued(LINK_PATH, 'the earlier edit');
    const upload = holdTabAUpload(server);
    const cycleA = runIncrementalSync(onServer(server).deps);
    await upload.uploading;

    // The link is edited again, and the other tab syncs.
    await seedQueued(LINK_PATH, 'the later edit');
    const other = onServer(server);
    const cycleB = tabB.engine.runIncrementalSync(other.deps);
    const queued = await queuedBehindLock();
    const ranMeanwhile = [...other.calls];
    // Both cycles are let finish BEFORE anything is asserted: a failed expectation
    // here would otherwise leave tab A's cycle holding its account's slot, and every
    // later case in the file would time out behind it.
    upload.land();
    await Promise.all([cycleA, cycleB]);

    // Its cycle was queued behind tab A's, and had not so much as listed.
    expect(queued).toBe(true);
    expect(ranMeanwhile).toEqual([]);
    expect(server.body(LINK_PATH)).toBe('the later edit');
    expect(await bodyAt(LINK_PATH)).toBe('the later edit');
    expect(await pendingPaths()).toEqual([]);
  });

  it('lets a second tab’s first sync wait for the first’s, and then lists nothing', async () => {
    // Two tabs open on the sign-in page, and one signs in: the other adopts the
    // session and its provider starts a first sync of its own. Unlocked, both
    // listed and downloaded the whole library side by side. Now the second waits,
    // and finds the job done — a first sync is a fact about the DEVICE's store.
    for (const id of ['l_m1', 'l_m2', 'l_m3']) server.otherClientPuts(`links/${id}.enc`, id);
    await db.syncMeta.clear();
    await beginInitialSync(USER);

    // Tab A's pull, stopped after its listing.
    let listed!: () => void;
    let resume!: () => void;
    const listing = new Promise<void>((resolve) => (listed = resolve));
    const held = new Promise<void>((resolve) => (resume = resolve));
    const first = onServer(server, {
      afterFilesPage: async () => {
        listed();
        await held;
      },
    });
    const pullA = runInitialSync(first.deps);
    await listing;

    const second = onServer(server);
    const pullB = tabB.engine.runInitialSync(second.deps);
    const queued = await queuedBehindLock();
    const ranMeanwhile = [...second.calls];
    resume();
    await Promise.all([pullA, pullB]);

    expect(queued).toBe(true);
    expect(ranMeanwhile).toEqual([]);
    // Not one call, then or after: no log read, no listing, and so no download —
    // a pull cannot fetch a blob it never asked for a URL to.
    expect(second.calls).toEqual([]);
    // The control: the first tab's pull is what filled the store, and it is done.
    expect(first.calls).toEqual(['ops/list', 'files/list', 'files/sign get']);
    expect(await bodyAt('links/l_m3.enc')).toBe('l_m3');
    expect((await db.syncMeta.get(USER))?.firstSyncDoneAt).toBeGreaterThan(0);
  });

  it('still syncs where Web Locks are missing', async () => {
    // The lock WIDENS single-flight; it must never be what sync depends on. A
    // context without the API (an old engine, a non-browser runtime) gets the
    // in-context single-flight alone, as before — not a TypeError on every cycle,
    // which would read as sync being down with nothing wrong on the network.
    await inSyncWith(server);
    await seedQueued(LINK_PATH, 'saved here');
    // Shadowed with an own property and un-shadowed by deleting it, so the
    // prototype's accessor is never replaced and a failure here leaves nothing
    // behind for the cases after it.
    Object.defineProperty(navigator, 'locks', { configurable: true, get: () => undefined });
    try {
      await runIncrementalSync(onServer(server).deps);
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }

    expect(server.body(LINK_PATH)).toBe('saved here');
    expect(await pendingPaths()).toEqual([]);
    // The control for this describe's first expectation: the API is back.
    expect(typeof navigator.locks?.request).toBe('function');
  });

  it('frees the slot when the lock itself cannot be taken', async () => {
    // The single-flight slot is set AFTER the cycle's promise is created, and
    // cleared in that promise's `finally`. So anything that throws before the
    // cycle's first await runs the `finally` first and the `set` second, and
    // leaves a rejected promise in the slot for good: every later sync on the
    // page joins it and fails with an error from long ago. Taking the lock is the
    // first thing a cycle does, which is what put a throw within reach of that
    // window — a `request` that throws rather than rejecting (a shim, a
    // locked-down webview) would have ended sync until a reload.
    const NO_LOCKS = new Error('locks unavailable');
    await inSyncWith(server);
    await seedQueued(LINK_PATH, 'saved here');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      get: () => ({
        request: () => {
          throw NO_LOCKS;
        },
      }),
    });
    let failed: unknown;
    try {
      failed = await runIncrementalSync(onServer(server).deps).catch((err: unknown) => err);
    } finally {
      delete (navigator as { locks?: unknown }).locks;
    }
    expect(failed).toBe(NO_LOCKS);

    // The next cycle is its own cycle: it runs, and it pushes.
    await expect(runIncrementalSync(onServer(server).deps)).resolves.toBeDefined();
    expect(server.body(LINK_PATH)).toBe('saved here');
    expect(await pendingPaths()).toEqual([]);
  });

  // The control, and the reason the lock is named per account: a cycle for an
  // account that has since signed out is fenced in the database, and the next
  // account's first sync must not sit behind its network calls timing out.
  it('does not make another account’s cycle wait', async () => {
    const OTHER_USER = 'bob';
    await inSyncWith(server);
    await inSyncWith(server, OTHER_USER);
    await seedQueued(LINK_PATH, 'an edit');
    const upload = holdTabAUpload(server);
    const cycleA = runIncrementalSync(onServer(server).deps);
    await upload.uploading;

    const other = onServer(server, {}, OTHER_USER);
    const cycleB = tabB.engine.runIncrementalSync(other.deps);
    // Finished — not merely started — while the other account's upload is still
    // out. Bounded like the waits above, so that a cycle that IS held up fails
    // this case after tab A has been let go, rather than hanging it.
    let settled = false;
    void cycleB.then(() => (settled = true));
    const finishedMeanwhile = await within(async () => settled);
    upload.land();
    await Promise.all([cycleA, cycleB]);

    // The whole of an idle cycle, run while the other account's was mid-upload.
    expect(finishedMeanwhile).toBe(true);
    expect(other.calls).toEqual(['ops/list']);
  });
});

// --- an op rewritten after the queue was read --------------------------------

// A cycle reads the queue once and orders the ops it read, content before the
// metadata that names it. But an op carries no bytes: each put reads its record
// when its own upload starts. So a metadata op that was already queued used to
// upload whatever its record held by THEN — and if a `files/` blob and the
// reference to it had both been written since (server extraction's second pass: the
// image, then the patch that names it), the cycle committed metadata naming content
// it held no op for and had not sent. The order was kept over the ops and broken
// over the bytes; another device pulling in that window got a preview it could not
// load, and remembered the miss for the rest of its session.
describe('an op whose path was rewritten after the queue was read', () => {
  // The cycle has read its queue and is signing the metadata chunk. Now the second
  // pass lands: content first, then the reference — the write edge's own order.
  const secondPassLands = async (_paths: string[], op: 'put' | 'get'): Promise<void> => {
    if (op !== 'put') return;
    await writeFile(USER, 'f_a', utf8('image bytes'));
    await writeExtraction(USER, 'l_a', { fields: { imageId: 'f_a' } });
  };

  beforeEach(async () => {
    // First pass: the title. Its op is what the cycle will be holding.
    await writeExtraction(USER, 'l_a', { fields: { title: 'A title' } });
  });

  it('uploads nothing for it — the record now names content this cycle holds no op for', async () => {
    let fired = false;
    await runIncrementalSync(
      deps({
        filesSign: async (paths, op) => {
          if (fired) return;
          fired = true;
          await secondPassLands(paths, op);
        },
      }),
    );

    expect(mockPutBlob).not.toHaveBeenCalled();
    expect(committedPaths()).toEqual([]);
    // Both writes are still queued, under their own ops.
    expect(await pendingPaths()).toEqual([EXTRACTION_PATH, FILE_PATH]);
  });

  it('pushes both on the next cycle, content first', async () => {
    let fired = false;
    await runIncrementalSync(
      deps({
        filesSign: async (paths, op) => {
          if (fired) return;
          fired = true;
          await secondPassLands(paths, op);
        },
      }),
    );

    await runIncrementalSync(deps());

    expect(commits.map((batch) => batch.map((o) => o.path))).toEqual([
      [FILE_PATH],
      [EXTRACTION_PATH],
    ]);
    expect(await pendingPaths()).toEqual([]);
  });

  it('leaves a path deleted since to its queued delete, and fetches nothing for it', async () => {
    // A put whose record is gone used to read as an ORPHAN — a wedged op to drop,
    // with the server's copy re-added to the downloads so the entity came back. But
    // this record is gone because the user deleted it a moment ago: the queue row is
    // a delete now, a newer intent, and going to fetch the server's copy of it is
    // work towards undoing what they just did.
    await seedQueued(LINK_PATH, 'an edit', 1500);
    mockGetBlob.mockResolvedValue(new Uint8Array([0xee, ...utf8('the server copy')]));

    await runIncrementalSync(
      deps({
        opsList: () => ({
          ops: [{ op: 'put', path: LINK_PATH, updatedAt: 2000 }],
          oldestUpdatedAt: 500,
          newestUpdatedAt: 2000,
          hasMore: false,
        }),
        filesSign: async (_paths, op) => {
          if (op === 'put') await deleteLink(USER, { path: LINK_PATH } as never);
        },
      }),
    );

    expect(mockGetBlob).not.toHaveBeenCalled();
    expect(await db.items.get(LINK_PATH)).toBeUndefined();
    expect(await db.pendingOps.toArray()).toMatchObject([{ path: LINK_PATH, op: 'delete' }]);
  });
});
