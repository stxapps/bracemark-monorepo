// The two ways to kick a cycle, and the one thing that tells them apart. A local
// edit (`requestSync`) bumps `localWriteNonce`, so the read edge applies this
// device's own change at once; a user's Sync (`syncNow`) must NOT, because what it
// brings in is another device's writes, which an engaged list stages behind the
// refresh pill. Routed through requestSync, a press while scrolled shifted every
// row under the reader — e2e SYNC-REFRESH-PILL-WEB-001 is the painted proof, this
// is the rule.

import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { SyncProvider, useSync } from './sync-provider';

const mockRunIncrementalSync = jest.fn(() => Promise.resolve({ blocked: false, blockedCount: 0 }));

let mockSessionState: 'active' | 'expired' = 'active';
jest.mock('./auth-provider', () => ({
  useAuth: () => ({ username: 'alice', status: 'authenticated', sessionState: mockSessionState }),
}));
// One client for the provider's lifetime: it is an effect dependency, and a new
// object per render would re-run the effect forever.
const mockApi = {};
jest.mock('@stxapps/react', () => ({
  ...jest.requireActual('@stxapps/react'),
  useApiClient: () => mockApi,
}));
jest.mock('../data/session-store', () => ({ getSession: () => ({ encryptionKey: {} }) }));
let mockFirstSyncDone = true;
const mockClaim = jest.fn((_username: string) => Promise.resolve());
const mockRunInitialSync = jest.fn(() => Promise.resolve());
jest.mock('../data/sync-store', () => ({
  claimIfStillSignedIn: (username: string) => mockClaim(username),
  isFirstSyncDone: () => Promise.resolve(mockFirstSyncDone),
}));
jest.mock('../sync/engine', () => ({
  runIncrementalSync: () => mockRunIncrementalSync(),
  runInitialSync: () => mockRunInitialSync(),
}));

const wrapper = ({ children }: { children: ReactNode }) => <SyncProvider>{children}</SyncProvider>;

async function readySync() {
  const hook = renderHook(() => useSync(), { wrapper });
  // Reaching 'ready' kicks one cycle of its own; start counting after it.
  await waitFor(() => expect(hook.result.current.storeStatus).toBe('ready'));
  await waitFor(() => expect(hook.result.current.bgSyncStatus).toBe('idle'));
  mockRunIncrementalSync.mockClear();
  return hook;
}

beforeEach(() => {
  mockClaim.mockClear();
  mockRunInitialSync.mockClear();
  mockRunIncrementalSync.mockClear();
  mockSessionState = 'active';
  mockFirstSyncDone = true;
});

it('marks a local write for requestSync', async () => {
  const { result } = await readySync();
  const before = result.current.localWriteNonce;
  act(() => result.current.requestSync());
  expect(result.current.localWriteNonce).toBe(before + 1);
  expect(mockRunIncrementalSync).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(result.current.bgSyncStatus).toBe('idle'));
});

it('runs the same cycle for syncNow without marking a local write', async () => {
  const { result } = await readySync();
  const before = result.current.localWriteNonce;
  act(() => result.current.syncNow());
  expect(result.current.localWriteNonce).toBe(before);
  expect(mockRunIncrementalSync).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(result.current.bgSyncStatus).toBe('idle'));
});

// The sign-out flow's cycle (docs/data-lifecycle.md, _the press, and the wait_): it
// syncs before it asks about unsynced changes, then re-reads the queue. So the promise
// has to last exactly as long as the cycle — one that settled early would have the flow
// count a queue the push had not reached yet, and ask about changes that were a moment
// from being saved — and it must not reject, because offline is the ordinary reason the
// queue is not empty.
describe('syncAndWait', () => {
  it('settles when the cycle does, and not before', async () => {
    const { result } = await readySync();
    let finish!: () => void;
    mockRunIncrementalSync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ blocked: false, blockedCount: 0 });
        }),
    );
    const before = result.current.localWriteNonce;
    let settled = false;

    let wait!: Promise<void>;
    act(() => {
      wait = result.current.syncAndWait().then(() => {
        settled = true;
      });
    });
    await act(async () => undefined);

    expect(mockRunIncrementalSync).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    // Not a local edit, so nothing for the read edge to promote.
    expect(result.current.localWriteNonce).toBe(before);

    await act(async () => {
      finish();
      await wait;
    });

    expect(settled).toBe(true);
    expect(result.current.bgSyncStatus).toBe('idle');
  });

  it('settles on a failed cycle without rejecting, and leaves the failure on the indicator', async () => {
    const { result } = await readySync();
    mockRunIncrementalSync.mockImplementationOnce(() => Promise.reject(new Error('offline')));

    await act(async () => {
      await expect(result.current.syncAndWait()).resolves.toBeUndefined();
    });

    expect(result.current.bgSyncStatus).toBe('error');
    expect(result.current.lastError).toBe('offline');
  });
});

// A first sync's writes are fenced on the account's ownership row, and a session
// adopted by an older build may have none. The claim is made here, just before the
// pull, and never at startup — where it would wait on the data store.
it('claims the account before a first sync, and only then', async () => {
  mockFirstSyncDone = false;
  const { result } = renderHook(() => useSync(), { wrapper });

  await waitFor(() => expect(result.current.storeStatus).toBe('ready'));
  expect(mockClaim).toHaveBeenCalledWith('alice');
  const [claimed] = mockClaim.mock.invocationCallOrder;
  const [pulled] = mockRunInitialSync.mock.invocationCallOrder;
  expect(claimed).toBeLessThan(pulled);
});

it('claims nothing for a store whose first sync is done', async () => {
  await readySync();

  expect(mockClaim).not.toHaveBeenCalled();
});

// An EXPIRED session (docs/sessions.md): the library stays usable, but the engine
// schedules nothing — a cycle could only earn the same `session_expired` — and the
// indicator says 'paused', not 'error' (nothing failed) and not 'idle' (nothing syncs).
describe('while the session is expired', () => {
  beforeEach(() => {
    mockSessionState = 'expired';
  });

  it('keeps the store open and runs no cycle, not even for a local write', async () => {
    const { result } = renderHook(() => useSync(), { wrapper });

    await waitFor(() => expect(result.current.storeStatus).toBe('ready'));
    expect(result.current.bgSyncStatus).toBe('paused');
    act(() => result.current.requestSync());
    act(() => result.current.syncNow());

    expect(mockRunIncrementalSync).not.toHaveBeenCalled();
    // The edit is still marked, so the read edge shows it at once.
    expect(result.current.localWriteNonce).toBe(1);
  });

  // Nothing to wait for: the sign-out flow goes straight on to the question.
  it('settles syncAndWait at once, with no cycle', async () => {
    const { result } = renderHook(() => useSync(), { wrapper });
    await waitFor(() => expect(result.current.storeStatus).toBe('ready'));

    await expect(result.current.syncAndWait()).resolves.toBeUndefined();

    expect(mockRunIncrementalSync).not.toHaveBeenCalled();
  });

  // The one thing a pause can't give: a first sync that never finished. That store is
  // incomplete, so the gate stays closed and says what will finish it.
  it('holds the gate on a first sync that never finished', async () => {
    mockFirstSyncDone = false;
    const { result } = renderHook(() => useSync(), { wrapper });

    await waitFor(() => expect(result.current.storeStatus).toBe('error'));
    expect(result.current.lastError).toMatch(/sign/i);
    expect(mockRunIncrementalSync).not.toHaveBeenCalled();
  });
});

it.each(['resolve', 'reject'] as const)(
  'keeps sync paused when the old active cycle later %ss',
  async (settlement) => {
    let resolve!: (value: { blocked: boolean; blockedCount: number }) => void;
    let reject!: (error: Error) => void;
    mockRunIncrementalSync.mockImplementationOnce(
      () =>
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    const { result, rerender } = renderHook(() => useSync(), { wrapper });
    await waitFor(() => expect(result.current.bgSyncStatus).toBe('syncing'));

    mockSessionState = 'expired';
    rerender(undefined);
    await waitFor(() => expect(result.current.bgSyncStatus).toBe('paused'));
    await act(async () => {
      if (settlement === 'resolve') resolve({ blocked: false, blockedCount: 0 });
      else reject(new Error('the old request failed'));
    });

    expect(result.current.bgSyncStatus).toBe('paused');
    expect(result.current.storeStatus).toBe('ready');
    expect(result.current.lastError).toBeNull();
  },
);
