import { createContext, type ReactNode, useContext } from 'react';

// True while AppLockGate's pane covers a signed-in app it has kept mounted (a
// relock — see that file). The gate hides its own subtree with `display: none`,
// but an OVERLAY that subtree opened is not in it: the kit's dialogs and menus
// portal to the root PortalHost, and on iOS they sit in a FullWindowOverlay,
// both above the lock pane. So the kit's portaled content reads this and
// unmounts while it is set (components/ui/dialog.tsx, alert-dialog.tsx,
// dropdown-menu.tsx); the owner's open state survives, so the overlay comes back
// on unlock. docs/locks.md, _overlays over a relock_.
//
// Defaults to false, so everything outside the gate — the lock pane itself, the
// auth screens — is never covered.
//
// A context provider to React, but not a Provider in the sense the files beside
// it use the word, which is why it does not carry the suffix: it owns no state —
// the gate decides `covered` — and the gate mounts it, not a layout. It marks a
// scope, the same shape as @stxapps/expo-react's LiveReadPause
// (contexts/live-read-pause.tsx carries the distinction in full).
const AppCoveredContext = createContext(false);

export function AppCover({ covered, children }: { covered: boolean; children: ReactNode }) {
  return <AppCoveredContext.Provider value={covered}>{children}</AppCoveredContext.Provider>;
}

export function useAppCovered(): boolean {
  return useContext(AppCoveredContext);
}
