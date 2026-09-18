import { type ReactNode, useRef } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

import { useLocks } from '@stxapps/expo-react';
import { LOCK_COPY } from '@stxapps/react';

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
export function AppLockGate({ children }: { children: ReactNode }) {
  const { status, appLock, unlockApp, biometricAvailable, biometricLabel, unlockAppWithBiometric } =
    useLocks();
  const shown = useRef(false);

  if (status === 'checking') return null;

  const locked = appLock.exists && !appLock.unlocked;
  if (!locked) shown.current = true;

  const pane = locked ? (
    <StyledSafeAreaView className="flex-1 bg-background">
      <LockPane
        testID="app-lock-pane"
        className="flex-1"
        title={LOCK_COPY.app.title}
        description={LOCK_COPY.app.description}
        onUnlock={unlockApp}
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
      <View style={{ flex: 1, display: locked ? 'none' : 'flex' }}>{children}</View>
      {pane}
    </>
  );
}
