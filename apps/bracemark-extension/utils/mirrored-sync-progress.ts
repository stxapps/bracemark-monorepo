import type { SyncCycleStep } from '@stxapps/shared';

// The background's sync-PROGRESS mirror — the twin of mirrored-sync-state.ts for
// the one value that changes ten times a second. The worker writes it while a
// pull or a push is moving (sync-runner.ts, through the shared coalescer at
// PROGRESS_FLUSH_MS); the popup reads it and subscribes (use-mirrored-sync-progress)
// to draw the count, the bar and the percent on its sync pill and detail view.
//
// `browser.storage.SESSION`, not `.local` like the status mirror, and that split
// is the point of a second key: `.session` is memory-backed, so a write is an IPC
// and no disk — ten a second for the length of a first sync cost nothing — and it
// is cleared on browser restart, which is right for a number that only means
// anything while the worker that writes it is running. Folded into the status
// mirror instead, every tick would rewrite the persisted record and re-render
// every `useSync()` consumer through it. Its default access level
// (TRUSTED_CONTEXTS) is the worker and the extension's own pages, which are
// exactly its writer and its readers.
//
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
