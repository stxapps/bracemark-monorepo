import { createContext, useContext } from 'react';

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
const AppCoveredContext = createContext(false);

export const AppCoveredProvider = AppCoveredContext.Provider;

export function useAppCovered(): boolean {
  return useContext(AppCoveredContext);
}
