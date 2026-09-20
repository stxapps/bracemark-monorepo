// The two ways to kick a cycle, and the one thing that tells them apart. A local
// edit (`requestSync`) bumps `localWriteNonce`, so the read edge applies this
// device's own change at once; a user's Sync (`syncNow`) must NOT, because what it
// brings in is another device's writes, which an engaged list stages behind the
// refresh pill. Routed through requestSync, a press while scrolled promoted the
// pull inside the grace window and the pill never lit — e2e
// SYNC-REFRESH-PILL-IOS-001/-ANDROID-001 are the painted proof, this is the rule.

import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react-native';

import { SyncProvider, useSync } from './sync-provider';

const mockRunIncrementalSync = jest.fn(() => Promise.resolve({ blocked: false, blockedCount: 0 }));

jest.mock('./auth-provider', () => ({
  useAuth: () => ({ username: 'alice', status: 'authenticated' }),
}));
// One client for the provider's lifetime: it is an effect dependency, and a new
// object per render would re-run the effect forever.
const mockApi = {};
jest.mock('@stxapps/react', () => ({ useApiClient: () => mockApi }));
jest.mock('../data/session-store', () => ({ getSession: () => ({ encryptionKey: {} }) }));
jest.mock('../data/sync-store', () => ({ isFirstSyncDone: () => Promise.resolve(true) }));
jest.mock('../sync/engine', () => ({
  runIncrementalSync: () => mockRunIncrementalSync(),
  runInitialSync: jest.fn(),
}));

const wrapper = ({ children }: { children: ReactNode }) => <SyncProvider>{children}</SyncProvider>;

// Mount, let the first-sync read and the cycle that 'ready' kicks both settle, and
// start counting cycles after it.
async function readySync() {
  const hook = renderHook(() => useSync(), { wrapper });
  await act(async () => {});
  expect(hook.result.current.storeStatus).toBe('ready');
  expect(hook.result.current.bgSyncStatus).toBe('idle');
  mockRunIncrementalSync.mockClear();
  return hook;
}

beforeEach(() => mockRunIncrementalSync.mockClear());

it('marks a local write for requestSync', async () => {
  const { result } = await readySync();
  const before = result.current.localWriteNonce;
  await act(async () => result.current.requestSync());
  expect(result.current.localWriteNonce).toBe(before + 1);
  expect(mockRunIncrementalSync).toHaveBeenCalledTimes(1);
});

it('runs the same cycle for syncNow without marking a local write', async () => {
  const { result } = await readySync();
  const before = result.current.localWriteNonce;
  await act(async () => result.current.syncNow());
  expect(result.current.localWriteNonce).toBe(before);
  expect(mockRunIncrementalSync).toHaveBeenCalledTimes(1);
});
