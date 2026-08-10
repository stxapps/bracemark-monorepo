import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

import { useSync } from '@stxapps/expo-react';

import { Button } from './ui/button';
import { Text } from './ui/text';

const StyledSafeAreaView = withUniwind(SafeAreaView);

// Renders the app subtree only once the local store is usable; otherwise shows an
// in-route loading/error screen — the expo port of bracemark-web's
// components/initial-sync-gate.tsx (the canonical doc). A CONTENT SWAP, not a
// redirect: the "decrypting" state is a loading phase of /links (etc.), not a
// place of its own, so there's no /sync route and no history entry — the layout
// still owns the children, we just hold them back until 'ready'.
//
// - 'checking'        → render nothing (just reading a flag; see below)
// - 'syncing-initial' → the decrypting screen (blocking first sync)
// - 'error'           → message + retry
// - 'ready'           → the app (background sync may still run)
//
// Named for what it gates: only the FIRST (initial) sync blocks here. By design,
// subsequent incremental/background syncs never gate the UI — they report on the
// separate bgSyncStatus dimension instead (see sync-provider).

// How long the first-sync screen stays up once shown, so a fast pull can't flash
// it. Only relevant to 'syncing-initial' (a network pull); 'checking' never shows
// a screen at all, so it needs no such floor.
const MIN_SCREEN_MS = 500;

export function InitialSyncGate({ children }: { children: ReactNode }) {
  const { storeStatus, retryInitialSync } = useSync();

  // No-flash: 'checking' is a single SQLite read of the first-sync flag and
  // happens on every mount. We never want the decrypting screen for it, so we
  // render nothing — a semantic guarantee, not a timing race. Returning visits go
  // 'checking' → 'ready' and never paint a loading screen.

  // Minimum-visible floor for the first-sync screen: once 'syncing-initial' shows
  // it, keep it up for MIN_SCREEN_MS even if the pull finishes sooner, so it can't
  // flicker. shownAtRef stays null on returning visits (the screen never showed),
  // so this whole block is a no-op for them.
  const shownAtRef = useRef<number | null>(null);
  const [released, setReleased] = useState(false);

  useEffect(() => {
    if (storeStatus !== 'ready' || shownAtRef.current === null) return;

    const remaining = MIN_SCREEN_MS - (performance.now() - shownAtRef.current);
    if (remaining <= 0) {
      setReleased(true);
      return;
    }

    const t = setTimeout(() => setReleased(true), remaining);
    return () => clearTimeout(t);
  }, [storeStatus]);

  if (storeStatus === 'checking') {
    shownAtRef.current = null; // fresh stamp for this attempt (covers error→retry)
    return null;
  }

  // Only the blocking initial sync can land here: background syncs report on
  // bgSyncStatus and never set the gate's 'error'.
  if (storeStatus === 'error') {
    return (
      <StyledSafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 px-6">
          <Text>Couldn’t sync your links.</Text>
          <Button variant="link" onPress={retryInitialSync}>
            <Text>Try again</Text>
          </Button>
        </View>
      </StyledSafeAreaView>
    );
  }

  // First pull on this device — show the decrypting screen, recording when it
  // first appeared so the minimum-visible floor can hold it.
  if (storeStatus === 'syncing-initial') {
    shownAtRef.current ??= performance.now();
    return <DecryptingScreen />;
  }

  // 'ready' — but if the first-sync screen showed and hasn't met its floor yet,
  // keep it up for the remainder before swapping in the app.
  if (shownAtRef.current !== null && !released) return <DecryptingScreen />;

  return children;
}

function DecryptingScreen() {
  return (
    <StyledSafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center gap-4 px-6">
        <ActivityIndicator size="small" />
        <Text>Decrypting your links…</Text>
      </View>
    </StyledSafeAreaView>
  );
}
