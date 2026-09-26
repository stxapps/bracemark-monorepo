// Pause the live reads of a subtree nobody can see. Every useLiveRead under a
// paused LiveReadPause only notes that it missed a change, the way it does under
// the bulk-write hold (data/live-read-invalidation.ts), and re-runs once when the
// pause lifts.
//
// Why a pause and not a freeze: the screen this exists for is the links screen
// while Settings covers it, and it stays mounted there. During a 10,000-link
// restore every hold flush re-rendered it, and that re-render was most of each
// longest stall (docs/data-lifecycle.md, _the restore profiled_). native-stack's
// `freezeOnBlur` never freezes the screen directly below the focused one on
// Fabric, and that is the only place the links screen ever sits under Settings.
// A freeze of our own would hide the frozen subtree, which a back-swipe reveals
// before the unfreeze could land. A paused read leaves the screen mounted and
// visible, and at worst a row is stale for the first frames of a reveal.
//
// Nested pauses combine: a subtree is paused if any LiveReadPause above it is.

import { createContext, type ReactNode, useContext } from 'react';

const LiveReadPauseContext = createContext(false);

export function LiveReadPause({ paused, children }: { paused: boolean; children: ReactNode }) {
  const outer = useContext(LiveReadPauseContext);
  return (
    <LiveReadPauseContext.Provider value={outer || paused}>
      {children}
    </LiveReadPauseContext.Provider>
  );
}

export function useLiveReadPaused(): boolean {
  return useContext(LiveReadPauseContext);
}
