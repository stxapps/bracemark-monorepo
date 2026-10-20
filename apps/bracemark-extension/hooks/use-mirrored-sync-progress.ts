import { useEffect, useState } from 'react';

import {
  MIRRORED_SYNC_PROGRESS_KEY,
  type MirroredSyncProgress,
  readMirroredSyncProgress,
} from '@/utils/mirrored-sync-progress';

// Live view of the background's sync-progress mirror (browser.storage.session):
// read once, so a popup opened mid-pull shows the count at once rather than after
// the next tick, then stay in step via storage.onChanged — the shape of
// useMirroredSyncState, on the other area.
export function useMirroredSyncProgress(): MirroredSyncProgress | null {
  const [progress, setProgress] = useState<MirroredSyncProgress | null>(null);

  useEffect(() => {
    let active = true;
    // A tick can land before the first read resolves; the read must not then
    // overwrite it with the older value.
    let ticked = false;
    void readMirroredSyncProgress().then((p) => {
      if (active && !ticked) setProgress(p);
    });

    const handler: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== 'session') return;
      const change = changes[MIRRORED_SYNC_PROGRESS_KEY];
      if (!change) return;
      ticked = true;
      setProgress((change.newValue as MirroredSyncProgress | undefined) ?? null);
    };
    browser.storage.onChanged.addListener(handler);

    return () => {
      active = false;
      browser.storage.onChanged.removeListener(handler);
    };
  }, []);

  return progress;
}
