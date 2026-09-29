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
//
// It is a context provider to React but not a Provider in the sense the rest of
// this folder uses the word, which is why it is the one file here without the
// suffix. Each *-provider.tsx beside it owns state or a service, takes only
// children and mounts once near the root. This owns nothing, since the caller
// decides `paused`, and it wraps whichever subtree should stop reading, at any
// depth, the way <Suspense> or <Activity> does. Nor is it a guard or a Gate
// (bracemark-expo's components/home-guard.tsx carries that split): it always
// renders its children, and never navigates or swaps them. It marks a scope, so
// it is named for what it does to that scope.

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
