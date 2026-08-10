import { useEffect, useState } from 'react';

import {
  INITIAL_MIRRORED_SYNC_STATE,
  MIRRORED_SYNC_STATE_KEY,
  type MirroredSyncState,
  readMirroredSyncState,
} from '@/utils/mirrored-sync-state';

// Live view of the background's sync-health mirror (browser.storage.local): reads the
// current value once, then stays in step via storage.onChanged. The single subscriber
// for that mirror on the React side — the popup provider tree uses it to feed
// ExternalSyncProvider (so every consumer reads status through useSync()), which is
// why the options page no longer subscribes on its own.
export function useMirroredSyncState(): MirroredSyncState {
  const [state, setState] = useState<MirroredSyncState>(INITIAL_MIRRORED_SYNC_STATE);

  useEffect(() => {
    let active = true;
    void readMirroredSyncState().then((s) => {
      if (active) setState(s);
    });

    const handler: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (area !== 'local') return;
      const next = changes[MIRRORED_SYNC_STATE_KEY]?.newValue as MirroredSyncState | undefined;
      if (next) setState(next);
    };
    browser.storage.onChanged.addListener(handler);

    return () => {
      active = false;
      browser.storage.onChanged.removeListener(handler);
    };
  }, []);

  return state;
}
