import type { BgSyncStatus, StoreStatus, SyncCycleStep } from '@stxapps/shared';

// The background's sync MIRROR in browser.storage. Distinct from the
// runtime.sendMessage command protocol in messages.ts: this is a broadcast channel —
// the worker writes it (sync-runner.ts), and the popup / options page read it or
// subscribe via storage.onChanged (hooks/use-mirrored-sync.ts), WITHOUT mounting the
// sync engine (SyncProvider) or round-tripping the worker.
//
// It is two records under two keys in two storage AREAS, split by how often each
// changes, and that split is the point:
//
//   - the STATUS (MirroredSyncState) is `.local`, written a few times a cycle and
//     read on every popup open, so it has to survive the worker being torn down
//     idle and the browser restarting;
//   - the PROGRESS (MirroredSyncProgress) is `.session`, written up to ten times a
//     second while a pull or a push is moving (through the shared coalescer at
//     PROGRESS_FLUSH_MS). `.session` is memory-backed, so a write is an IPC and no
//     disk — ten a second for the length of a first sync cost nothing — and it is
//     cleared on browser restart, which is right for a number that only means
//     anything while the worker that writes it is running. Folded into the status
//     record instead, every tick would rewrite the persisted value and re-render
//     every `useSync()` consumer through it. `.session`'s default access level
//     (TRUSTED_CONTEXTS) is the worker and the extension's own pages, which are
//     exactly its writer and its readers.

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

// The background's writer for the status.
export async function writeMirroredSyncState(state: MirroredSyncState): Promise<void> {
  await browser.storage.local.set({ [MIRRORED_SYNC_STATE_KEY]: state });
}

// `step` folds the two engine feeds into one value: 'initial' is the blocking
// first sync's InitialSyncProgress, 'upload'/'download' a background cycle's
// SyncCycleProgress. One key, because one run reports one of them at a time.
export interface MirroredSyncProgress {
  step: 'initial' | SyncCycleStep;
  done: number;
  total: number;
}

export const MIRRORED_SYNC_PROGRESS_KEY = 'mirroredSyncProgress';

export async function readMirroredSyncProgress(): Promise<MirroredSyncProgress | null> {
  const res = await browser.storage.session.get(MIRRORED_SYNC_PROGRESS_KEY);
  return (res[MIRRORED_SYNC_PROGRESS_KEY] as MirroredSyncProgress | undefined) ?? null;
}

export async function writeMirroredSyncProgress(progress: MirroredSyncProgress): Promise<void> {
  await browser.storage.session.set({ [MIRRORED_SYNC_PROGRESS_KEY]: progress });
}

// Removed rather than written as null, so a reader's absent-key fallback is the
// one "no number" spelling.
export async function clearMirroredSyncProgress(): Promise<void> {
  await browser.storage.session.remove(MIRRORED_SYNC_PROGRESS_KEY);
}
