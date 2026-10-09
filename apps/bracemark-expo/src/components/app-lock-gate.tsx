import { type ReactNode, useRef, useState } from 'react';
import { View } from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { SafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

import { useLocks } from '@stxapps/expo-react';
import { LOCK_COPY } from '@stxapps/react';

import { AppCoveredProvider } from '../contexts/app-covered-provider';
import { LockPane } from './lock-pane';

const StyledSafeAreaView = withUniwind(SafeAreaView);

// Holds the whole signed-in app behind the device-local app lock (Settings →
// Misc) — the expo port of bracemark-web's components/app-lock-gate.tsx (the
// canonical doc): a CONTENT SWAP, not a redirect, mounted inside SyncProvider
// so the first sync proceeds behind the lock screen.
//
// 'checking' — the first locks read — renders nothing, the same no-flash
// guarantee as web: a device with no app lock must never flash a lock screen,
// and a locked one must never flash the app. Whether the lock is UNLOCKED is
// in-memory only (lock-provider), so a relaunch always re-engages it.
//
// ONCE THE APP HAS BEEN SHOWN, A RELOCK HIDES IT RATHER THAN UNMOUNTING IT. The
// children are the (app) group's Stack, and this gate sits inside that group's
// route: "Lock app" (more-options-menu.tsx) and the background auto-relock
// (lock-provider) both engage the gate while the navigator is live. Unmounting it
// there and remounting it on unlock left a navigator with no screen — a blank
// app and a "GO_BACK was not handled" warning, on iOS and Android alike (found by
// LOCK-APP-002). So after the first unlock the subtree stays mounted inside a
// `display: none` wrapper while the pane is up: not painted, and dropped from
// the accessibility tree on both platforms, which is the same absence the swap
// gave. A cold start is unchanged — the app is never mounted until the first
// unlock, so nothing can flash — and the wrapper is rendered from that first
// unlock on, so relocking never changes the element tree above the navigator.
//
// `display: none` only reaches what is IN the subtree, and not every overlay the
// app opens is (docs/locks.md, _overlays over a relock_). The kit's dialogs and
// menus portal to the root PortalHost — on iOS inside a FullWindowOverlay — and
// stayed up over the pane, so the provider below tells them to unmount while
// covered (contexts/app-covered-provider.tsx). A react-native `Modal` is its
// own window on Android and stayed up too; its one user gates `visible` on the
// same flag. The router modal (`edit-link`) IS reached: hidden on both
// platforms — though iOS dismisses it outright, so an unsaved edit there does
// not survive the relock.
// Lint confines new overlays to the kit (eslint.config.mjs).
//
// And the flag outlasts the pane until the pane's KEYBOARD is down. Unlocking
// by password ends with the pane's field focused, so the keyboard is still up
// — or mid-hide — in the commit that uncovers the app. An overlay that
// re-presents in that commit mounts into it: the advanced-search sheet's
// StickyFooter seeded its lift from the keyboard that was up and then missed
// the hide, and stayed a keyboard's height up the screen (measured on Android).
// Held until the keyboard reports hidden, everything returns into a settled
// screen; a biometric unlock, with no keyboard, releases at once.
export function AppLockGate({ children }: { children: ReactNode }) {
  const { status, appLock, unlockApp, biometricAvailable, biometricLabel, unlockAppWithBiometric } =
    useLocks();
  const shown = useRef(false);
  const keyboardUp = useKeyboardState((state) => state.isVisible);
  const [settling, setSettling] = useState(false);

  if (status === 'checking') return null;

  const locked = appLock.exists && !appLock.unlocked;
  if (!locked) shown.current = true;
  // State adjusted during render (React's documented pattern), so the latch
  // engages in the same commit the pane goes up and never lags a frame behind.
  if (locked && !settling) setSettling(true);
  if (!locked && settling && !keyboardUp) setSettling(false);
  const covered = locked || settling;

  const pane = locked ? (
    <StyledSafeAreaView className="flex-1 bg-background">
      <LockPane
        testID="app-lock-pane"
        className="flex-1"
        title={LOCK_COPY.app.title}
        description={LOCK_COPY.app.description}
        onUnlock={unlockApp}
        // "Lock app" (more-options-menu.tsx) puts this pane up under the thumb
        // that just asked for it: no keyboard, and no Face ID sheet opening the
        // gate straight back. A cold start and the auto-relock still ask.
        solicit={!appLock.lockedByHand}
        biometric={
          appLock.biometric && biometricAvailable
            ? { label: biometricLabel, onUnlock: unlockAppWithBiometric }
            : undefined
        }
      />
    </StyledSafeAreaView>
  ) : null;

  if (!shown.current) return pane;

  return (
    <>
      <View style={{ flex: 1, display: locked ? 'none' : 'flex' }}>
        <AppCoveredProvider value={covered}>{children}</AppCoveredProvider>
      </View>
      {pane}
    </>
  );
}
