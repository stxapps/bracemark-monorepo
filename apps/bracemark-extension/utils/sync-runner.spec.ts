import type { SyncOutcome } from '@stxapps/shared';
import type { SyncDeps } from '@stxapps/web-react';

import { type FakeBrowser, installFakeBrowser } from '../testing/fake-browser';
import { MIRRORED_SYNC_PROGRESS_KEY } from './mirrored-sync-progress';
import { MIRRORED_SYNC_STATE_KEY, type MirroredSyncState } from './mirrored-sync-state';

// The background's sync runner. The engine itself is pinned in web-react's
// `engine.spec.ts` (docs/testing.md, _the ported pair_); what is only true HERE is
// the worker-level wrapper around it, and every one of its rules fails silently:
//
//   - SELECTIVE SYNC. `pathFilter` decides which blob families the extension
//     materializes. Dropping one costs no error — `settings/` missing means the
//     synced theme silently falls back to the default, `lists/`+`tags/` missing
//     means the save editor's pickers show only the system lists and zero tags.
//   - SINGLE-FLIGHT WITH A TRAILING RERUN. Overlapping triggers (the hourly alarm
//     landing on a save's KICK_SYNC) share the in-flight cycle, but a trigger that
//     arrives mid-cycle may have enqueued ops the running cycle already collected
//     past — so exactly one extra cycle has to follow. Without it those ops sit
//     locally until the next wake, worst case an hour.
//   - THE MIRROR IS THE ONLY OUTPUT. The popup and options page never call this;
//     they read browser.storage.local. A cycle that ran perfectly and mirrored
//     nothing is indistinguishable from one that never ran.
//
// The engine and the api client are mocked: this file's job is the ordering and
// the state it publishes, and a real cycle would only re-test web-react here.

const mockClaim = jest.fn<Promise<void>, [string]>();
const mockGetSession = jest.fn<{ username: string; encryptionKey: unknown } | null, []>();
const mockIsFirstSyncDone = jest.fn<Promise<boolean>, [string]>();
type Report = (...args: number[] | [string, number, number]) => void;
const mockRunInitialSync = jest.fn<Promise<void>, [SyncDeps, Report?]>();
const mockRunIncrementalSync = jest.fn<Promise<SyncOutcome>, [SyncDeps, Report?]>();

jest.mock('@stxapps/web-react', () => ({
  claimIfStillSignedIn: mockClaim,
  getSession: mockGetSession,
  isFirstSyncDone: mockIsFirstSyncDone,
  runInitialSync: mockRunInitialSync,
  runIncrementalSync: mockRunIncrementalSync,
}));

// Never called here: a bound client only records which session it was bound to,
// so the spec can see the cycle's token came from the record its key did.
jest.mock('./api-client', () => ({
  apiClient: { withSession: (session: unknown) => ({ boundTo: session }) },
}));

const SESSION = { username: 'alice', encryptionKey: { type: 'fake-key' } };
const CLEAN: SyncOutcome = { blocked: false, blockedCount: 0 };

let fake: FakeBrowser;

/** A cold service worker: the module's single-flight and mirror state start empty. */
function freshRunner(): typeof import('./sync-runner') {
  jest.resetModules();
  return require('./sync-runner') as typeof import('./sync-runner');
}

/** What the popup would read out of the mirror right now. */
function mirror(): MirroredSyncState {
  return fake.storage.local.peek(MIRRORED_SYNC_STATE_KEY) as MirroredSyncState;
}

/** Every mirror value written so far, oldest first — the sequence the popup sees. */
function mirrorHistory(): MirroredSyncState[] {
  const seen: MirroredSyncState[] = [];
  fake.storage.onChanged.addListener((changes) => {
    const next = changes[MIRRORED_SYNC_STATE_KEY]?.newValue;
    if (next) seen.push(next as MirroredSyncState);
  });
  return seen;
}

/** A promise the spec resolves by hand, to hold a cycle open. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  fake = installFakeBrowser();
  jest.clearAllMocks();
  mockGetSession.mockReturnValue(SESSION);
  mockIsFirstSyncDone.mockResolvedValue(true);
  mockRunIncrementalSync.mockResolvedValue(CLEAN);
  mockRunInitialSync.mockResolvedValue(undefined);
  mockClaim.mockResolvedValue(undefined);
});

describe('runSync — what it mirrors', () => {
  it('presents a ready, idle store when signed out, and runs no cycle', async () => {
    mockGetSession.mockReturnValue(null);

    await freshRunner().runSync();

    expect(mockRunInitialSync).not.toHaveBeenCalled();
    expect(mockRunIncrementalSync).not.toHaveBeenCalled();
    expect(mirror()).toMatchObject({ storeStatus: 'ready', bgSyncStatus: 'idle' });
  });

  it('runs the INITIAL pull on a device that has never synced, gating the store while it does', async () => {
    mockIsFirstSyncDone.mockResolvedValue(false);
    const seen = mirrorHistory();

    await freshRunner().runSync();

    expect(mockRunInitialSync).toHaveBeenCalledTimes(1);
    expect(mockRunIncrementalSync).not.toHaveBeenCalled();
    // The gate has to be raised BEFORE the pull, or the popup renders an empty
    // library as if it were the whole library — and in the same write as the
    // cycle's 'syncing', or the phase reads 'checking' meanwhile.
    expect(seen.map((s) => s.storeStatus)).toEqual(['syncing-initial', 'ready']);
    expect(mirror().bgSyncStatus).toBe('idle');
  });

  // A cold worker — torn down idle, spun up for the next trigger — used to start
  // its copy of the mirror from the initial state, so its first write said
  // 'checking' with no lastSyncAt: "Checking…" and "Last sync: Never" in the
  // popup for the whole of every such cycle.
  it('keeps a cold worker’s cycle reading as a sync of a ready store, with its history', async () => {
    await fake.storage.local.set({
      [MIRRORED_SYNC_STATE_KEY]: {
        storeStatus: 'ready',
        bgSyncStatus: 'idle',
        lastSyncAt: 1234,
        lastError: null,
        blockedCount: 0,
      },
    });
    const cycle = deferred<SyncOutcome>();
    mockRunIncrementalSync.mockReturnValue(cycle.promise);

    const run = freshRunner().runSync();
    while (mockRunIncrementalSync.mock.calls.length === 0) await Promise.resolve();

    expect(mirror()).toMatchObject({
      storeStatus: 'ready',
      bgSyncStatus: 'syncing',
      lastSyncAt: 1234,
    });
    cycle.resolve(CLEAN);
    await run;
  });

  // Left at 'syncing-initial', a failed first pull read as "Setting up this
  // device…" forever, with the error underneath and no Retry.
  it('mirrors a failed FIRST pull as the gate’s failure, so the popup offers its retry', async () => {
    mockIsFirstSyncDone.mockResolvedValue(false);
    mockRunInitialSync.mockRejectedValue(new Error('offline'));

    await freshRunner().runSync();

    expect(mirror()).toMatchObject({
      storeStatus: 'error',
      bgSyncStatus: 'error',
      lastError: 'offline',
    });
  });

  // The pull's writes are fenced on the account's ownership row, which the engine
  // never claims. With no popup open, this worker can be the first to pull for a
  // session an older build adopted without one — and every write would be refused.
  it('claims the account before the initial pull, and not before a later cycle', async () => {
    mockIsFirstSyncDone.mockResolvedValue(false);
    await freshRunner().runSync();

    expect(mockClaim).toHaveBeenCalledWith('alice');
    const [claimed] = mockClaim.mock.invocationCallOrder;
    const [pulled] = mockRunInitialSync.mock.invocationCallOrder;
    expect(claimed).toBeLessThan(pulled);

    mockClaim.mockClear();
    mockIsFirstSyncDone.mockResolvedValue(true);
    await freshRunner().runSync();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it('runs an INCREMENTAL cycle once the first sync is done', async () => {
    const seen = mirrorHistory();

    await freshRunner().runSync();

    expect(mockRunIncrementalSync).toHaveBeenCalledTimes(1);
    expect(mockRunInitialSync).not.toHaveBeenCalled();
    expect(seen.map((s) => s.bgSyncStatus)).toEqual(['syncing', 'idle']);
    expect(mirror()).toMatchObject({ storeStatus: 'ready', lastError: null, blockedCount: 0 });
  });

  it('reports a cycle the quota gate partly refused as blocked, not as idle and not as an error', async () => {
    mockRunIncrementalSync.mockResolvedValue({ blocked: true, blockedCount: 12 });

    await freshRunner().runSync();

    // Flattening this to 'idle' would tell the popup everything synced while a
    // dozen links sit queued, and leaves the pill's "Storage full" unreachable.
    expect(mirror()).toMatchObject({
      storeStatus: 'ready',
      bgSyncStatus: 'blocked-capacity',
      blockedCount: 12,
      lastError: null,
    });
  });

  it('stamps lastSyncAt on a completed cycle', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);

    await freshRunner().runSync();

    expect(mirror().lastSyncAt).toBe(1_700_000_000_000);
    jest.restoreAllMocks();
  });

  it('mirrors a failed cycle as an error carrying its message, and resolves rather than rejecting', async () => {
    mockRunIncrementalSync.mockRejectedValue(new Error('offline'));

    await expect(freshRunner().runSync()).resolves.toBeUndefined();

    expect(mirror()).toMatchObject({
      bgSyncStatus: 'error',
      lastError: 'offline',
      blockedCount: 0,
    });
  });

  it('clears a previous cycle’s error once one succeeds', async () => {
    const runner = freshRunner();
    mockRunIncrementalSync.mockRejectedValueOnce(new Error('offline'));
    await runner.runSync();
    expect(mirror().lastError).toBe('offline');

    await runner.runSync();

    expect(mirror()).toMatchObject({ bgSyncStatus: 'idle', lastError: null });
  });
});

// The progress mirror (mirrored-sync-progress.ts): storage.SESSION, coalesced to
// the apps' repaint rate, and gone once the run is — a number left behind would
// draw a bar over a sync that has ended.
describe('runSync — the progress mirror', () => {
  const progress = () => fake.storage.session.peek(MIRRORED_SYNC_PROGRESS_KEY);

  it('mirrors the first pull’s count into session storage, coalesced, then clears it', async () => {
    jest.useFakeTimers();
    try {
      mockIsFirstSyncDone.mockResolvedValue(false);
      const pull = deferred<void>();
      mockRunInitialSync.mockImplementation((_deps, report) => {
        for (let done = 0; done <= 40; done++) report?.(done, 200);
        return pull.promise;
      });
      const writes = jest.spyOn(fake.storage.session, 'set');

      const run = freshRunner().runSync();
      while (mockRunInitialSync.mock.calls.length === 0) await Promise.resolve();
      await jest.advanceTimersByTimeAsync(100);

      // Forty-one ticks, one write: the latest.
      expect(writes).toHaveBeenCalledTimes(1);
      expect(progress()).toEqual({ step: 'initial', done: 40, total: 200 });
      // Never the persisted status mirror's job.
      expect(fake.storage.local.peek(MIRRORED_SYNC_PROGRESS_KEY)).toBeUndefined();

      pull.resolve();
      await run;
      expect(progress()).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('mirrors a background cycle’s leg by name', async () => {
    jest.useFakeTimers();
    try {
      const cycle = deferred<SyncOutcome>();
      mockRunIncrementalSync.mockImplementation((_deps, report) => {
        (report as (s: string, d: number, t: number) => void)?.('upload', 3, 10);
        return cycle.promise;
      });

      const run = freshRunner().runSync();
      while (mockRunIncrementalSync.mock.calls.length === 0) await Promise.resolve();
      await jest.advanceTimersByTimeAsync(100);

      expect(progress()).toEqual({ step: 'upload', done: 3, total: 10 });
      cycle.resolve(CLEAN);
      await run;
      expect(progress()).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears what a torn-down worker left behind before it reports anything', async () => {
    await fake.storage.session.set({
      [MIRRORED_SYNC_PROGRESS_KEY]: { step: 'download', done: 5, total: 9 },
    });
    let seenAtStart: unknown = 'unread';
    mockRunIncrementalSync.mockImplementation(async () => {
      seenAtStart = progress();
      return CLEAN;
    });

    await freshRunner().runSync();

    expect(seenAtStart).toBeUndefined();
  });
});

describe('runSync — the selective sync', () => {
  // Materializing a family the popup reads is invisible when it works and
  // invisible when it doesn't: the theme falls back to the default and the save
  // editor's pickers come up empty, with no error anywhere.
  it.each([
    ['links/abc.enc', true],
    ['extractions/abc.enc', true],
    ['files/abc.enc', true],
    ['settings/general.enc', true],
    ['lists/index.enc', true],
    ['tags/index.enc', true],
    // Browse-only, and the popup has no library list to browse.
    ['pins/index.enc', false],
  ])('%s is downloaded: %s', async (path, wanted) => {
    await freshRunner().runSync();

    const deps = mockRunIncrementalSync.mock.calls[0][0];
    expect(deps.pathFilter?.(path)).toBe(wanted);
  });

  // Key and token from the one record (docs/sessions.md, _one record per run_): a
  // client reading the mirror per request would send whichever account the popup
  // signs into mid-cycle.
  it('hands the engine the session it just read, its api bound to that record', async () => {
    await freshRunner().runSync();

    expect(mockRunIncrementalSync.mock.calls[0][0]).toMatchObject({
      username: 'alice',
      encryptionKey: SESSION.encryptionKey,
      api: { boundTo: SESSION },
    });
  });
});

describe('runSync — single-flight', () => {
  it('coalesces overlapping triggers into the running cycle plus ONE trailing rerun', async () => {
    const first = deferred<SyncOutcome>();
    mockRunIncrementalSync.mockReturnValueOnce(first.promise);
    const runner = freshRunner();

    const a = runner.runSync();
    // Two more triggers land while the first cycle is still uploading — an alarm
    // and a post-EXTRACT kick, say. They may have enqueued ops the running cycle
    // already collected past, so they earn a rerun; but ONE, not two.
    const b = runner.runSync();
    const c = runner.runSync();
    first.resolve(CLEAN);
    await Promise.all([a, b, c]);

    expect(mockRunIncrementalSync).toHaveBeenCalledTimes(2);
  });

  it('gives every overlapping caller the same in-flight promise', async () => {
    const first = deferred<SyncOutcome>();
    mockRunIncrementalSync.mockReturnValueOnce(first.promise);
    const runner = freshRunner();

    const a = runner.runSync();
    const b = runner.runSync();
    expect(b).toBe(a);

    first.resolve(CLEAN);
    await a;
  });

  it('starts a fresh cycle once the previous one has settled', async () => {
    const runner = freshRunner();

    await runner.runSync();
    await runner.runSync();

    expect(mockRunIncrementalSync).toHaveBeenCalledTimes(2);
  });

  it('drops the pending rerun when the cycle fails — the retry is a fresh kick', async () => {
    const first = deferred<SyncOutcome>();
    mockRunIncrementalSync.mockReturnValueOnce(first.promise);
    const runner = freshRunner();

    const a = runner.runSync();
    const b = runner.runSync();
    first.reject(new Error('offline'));
    await Promise.all([a, b]);

    // A rerun here would re-enter the same failure immediately and overwrite the
    // error the popup is about to show.
    expect(mockRunIncrementalSync).toHaveBeenCalledTimes(1);
    expect(mirror()).toMatchObject({ bgSyncStatus: 'error', lastError: 'offline' });
  });
});
