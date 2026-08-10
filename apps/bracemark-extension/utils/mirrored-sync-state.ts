import type { BgSyncStatus, StoreStatus } from '@stxapps/shared';

// The background's sync-health MIRROR in browser.storage.local. Distinct from the
// runtime.sendMessage command protocol in messages.ts: this is a broadcast channel —
// the worker writes once per cycle (writeMirroredSyncState), and the popup / options
// page read it (readMirroredSyncState) or subscribe via storage.onChanged, WITHOUT
// mounting the sync engine (SyncProvider) or round-tripping the worker.
//
// `storeStatus` reuses web-react's gate phases; `bgSyncStatus` its indicator phases.
// `lastSyncAt` is the epoch ms the last cycle finished (success or fail); `lastError`
// is the last cycle's error message, or null; `blockedCount` is how many pending ops
// the plan/quota gate refused (the detail for a `blocked-*` status, as `lastError` is
// for 'error'). These five are exactly the fields web-react's SyncContextValue now
// carries, so useMirroredSyncState() can feed ExternalSyncProvider directly.
export interface MirroredSyncState {
  storeStatus: StoreStatus;
  bgSyncStatus: BgSyncStatus;
  lastSyncAt: number | null;
  lastError: string | null;
  blockedCount: number;
}

export const MIRRORED_SYNC_STATE_KEY = 'mirroredSyncState';

export const INITIAL_MIRRORED_SYNC_STATE: MirroredSyncState = {
  storeStatus: 'checking',
  bgSyncStatus: 'idle',
  lastSyncAt: null,
  lastError: null,
  blockedCount: 0,
};

// Read the mirrored sync state from storage (the popup/options path that doesn't
// round-trip the worker). Falls back to the initial state before the first cycle.
export async function readMirroredSyncState(): Promise<MirroredSyncState> {
  const res = await browser.storage.local.get(MIRRORED_SYNC_STATE_KEY);
  return (
    (res[MIRRORED_SYNC_STATE_KEY] as MirroredSyncState | undefined) ?? INITIAL_MIRRORED_SYNC_STATE
  );
}

// The background's writer for the mirror.
export async function writeMirroredSyncState(state: MirroredSyncState): Promise<void> {
  await browser.storage.local.set({ [MIRRORED_SYNC_STATE_KEY]: state });
}
