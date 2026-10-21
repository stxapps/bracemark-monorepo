import { useEffect, useState } from 'react';

import {
  INITIAL_MIRRORED_SYNC_STATE,
  MIRRORED_SYNC_PROGRESS_KEY,
  MIRRORED_SYNC_STATE_KEY,
  type MirroredSyncProgress,
  type MirroredSyncState,
  readMirroredSyncProgress,
  readMirroredSyncState,
} from '@/utils/mirrored-sync';

// Live view of one record of the background's sync mirror (utils/mirrored-sync.ts):
// read once, so a popup opened mid-cycle shows the current value at once rather than
// after the next write, then stay in step via storage.onChanged. `fallback` is what
// the area holds before the first write, so a removed key reads as `read` would.
function useStorageMirror<T>(
  area: 'local' | 'session',
  key: string,
  read: () => Promise<T>,
  fallback: T,
): T {
  const [value, setValue] = useState<T>(fallback);

  useEffect(() => {
    let active = true;
    // A write can land before the first read resolves; the read must not then
    // overwrite it with the older value. For the status that would stick until the
    // next cycle's write, not just until the next progress tick.
    let changed = false;
    void read().then((v) => {
      if (active && !changed) setValue(v);
    });

    const handler: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      changedArea,
    ) => {
      if (changedArea !== area) return;
      const change = changes[key];
      if (!change) return;
      changed = true;
      setValue((change.newValue as T | undefined) ?? fallback);
    };
    browser.storage.onChanged.addListener(handler);

    return () => {
      active = false;
      browser.storage.onChanged.removeListener(handler);
    };
  }, [area, key, read, fallback]);

  return value;
}

// The sync status (browser.storage.local). The single subscriber for it on the React
// side — the popup provider tree uses it to feed ExternalSyncProvider (so every
// consumer reads status through useSync()), which is why the options page no longer
// subscribes on its own.
export function useMirroredSyncState(): MirroredSyncState {
  return useStorageMirror(
    'local',
    MIRRORED_SYNC_STATE_KEY,
    readMirroredSyncState,
    INITIAL_MIRRORED_SYNC_STATE,
  );
}

// The sync progress (browser.storage.session): null when no pull or push is moving.
export function useMirroredSyncProgress(): MirroredSyncProgress | null {
  return useStorageMirror<MirroredSyncProgress | null>(
    'session',
    MIRRORED_SYNC_PROGRESS_KEY,
    readMirroredSyncProgress,
    null,
  );
}
