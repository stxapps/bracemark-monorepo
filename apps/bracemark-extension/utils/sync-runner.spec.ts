import type { SyncOutcome } from '@stxapps/shared';
import type { SyncDeps } from '@stxapps/web-react';

import { type FakeBrowser, installFakeBrowser } from '../testing/fake-browser';
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

const mockGetSession = jest.fn<{ username: string; encryptionKey: unknown } | null, []>();
const mockIsFirstSyncDone = jest.fn<Promise<boolean>, [string]>();
const mockRunInitialSync = jest.fn<Promise<void>, [SyncDeps]>();
const mockRunIncrementalSync = jest.fn<Promise<SyncOutcome>, [SyncDeps]>();

jest.mock('@stxapps/web-react', () => ({
  getSession: mockGetSession,
  isFirstSyncDone: mockIsFirstSyncDone,
  runInitialSync: mockRunInitialSync,
  runIncrementalSync: mockRunIncrementalSync,
}));

// Only its identity matters — it is threaded into SyncDeps and never called here.
jest.mock('./api-client', () => ({ apiClient: { baseUrl: 'https://api.test' } }));

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
    // library as if it were the whole library.
    expect(seen.map((s) => s.storeStatus)).toEqual(['checking', 'syncing-initial', 'ready']);
    expect(mirror().bgSyncStatus).toBe('idle');
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

  it('hands the engine the session it just read', async () => {
    await freshRunner().runSync();

    expect(mockRunIncrementalSync.mock.calls[0][0]).toMatchObject({
      username: 'alice',
      encryptionKey: SESSION.encryptionKey,
      api: { baseUrl: 'https://api.test' },
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
