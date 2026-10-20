import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

import { useAuth, useSync } from '@stxapps/expo-react';
import { SESSION_COPY } from '@stxapps/react';
import { type InitialSyncProgress, initialSyncProgressLabel } from '@stxapps/shared';

import { Button } from './ui/button';
import { Text } from './ui/text';
import { ErrorText } from './error-text';
import { ProgressMeter } from './progress-meter';
import { SyncPausedActions } from './sync-paused-notice';

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
//
// The screen shows a real COUNT beside its bar and percent rather than a bare
// spinner — the reasoning is on the web twin, which is the canonical copy, and
// the drawing is ProgressMeter, shared with the Data card. The one divergence is
// the ActivityIndicator: it stands in for the bar while the pull is still listing
// (native expects a spinner where web is happy with a line of text), and the two
// never show at once.

// How long the first-sync screen stays up once shown, so a fast pull can't flash
// it. Only relevant to 'syncing-initial' (a network pull); 'checking' never shows
// a screen at all, so it needs no such floor.
const MIN_SCREEN_MS = 500;

export function InitialSyncGate({ children }: { children: ReactNode }) {
  const { storeStatus, initialSyncProgress, initialSyncRetrying, retryInitialSync, lastError } =
    useSync();
  const { sessionState } = useAuth();

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
  // The session EXPIRED before this device's first sync finished (docs/sessions.md)
  // — web's gate carries the same branch. Nothing failed and nothing was lost, but
  // the store isn't complete, so the gate stays closed and offers the resume. A
  // status, not ErrorText: the user didn't cause it.
  if (storeStatus === 'error' && sessionState === 'expired') {
    return (
      <StyledSafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 px-6">
          <View className="items-center gap-1">
            <Text role="status" className="text-center text-sm font-medium">
              {SESSION_COPY.paused.title}
            </Text>
            <Text className="text-center text-xs text-muted-foreground">{lastError}</Text>
          </View>
          <SyncPausedActions align="center" />
        </View>
      </StyledSafeAreaView>
    );
  }

  if (storeStatus === 'error') {
    return (
      <StyledSafeAreaView className="flex-1 bg-background">
        <View className="flex-1 items-center justify-center gap-4 px-6">
          <View className="items-center gap-1">
            {/*
              ErrorText, not a bare Text: this message mounts as the result of the
              user signing in, and the carrier is what makes it announce
              (docs/accessibility.md — the one rule). The web twin spells the same
              thing as a `role="alert"` wrapper, which is why this is ErrorText and
              not SettingsNotice.
            */}
            <ErrorText className="text-center">Couldn’t sync your links.</ErrorText>
            {/*
              The pull is resumable — storeDownloads skips every path already
              stored, so a retry re-fetches only the remainder — but nothing on
              screen said so, which is what makes a user sit through a stalled
              first sync afraid to background the app.
            */}
            <Text className="text-center text-xs text-muted-foreground">
              Nothing was lost — trying again picks up where it left off.
            </Text>
          </View>
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
    return <DecryptingScreen progress={initialSyncProgress} retrying={initialSyncRetrying} />;
  }

  // 'ready' — but if the first-sync screen showed and hasn't met its floor yet,
  // keep it up for the remainder before swapping in the app. The provider keeps
  // the final count alive across that switch, so this holds a FULL bar rather than
  // dropping back to the spinner for the last few hundred ms.
  if (shownAtRef.current !== null && !released) {
    return <DecryptingScreen progress={initialSyncProgress} />;
  }

  return children;
}

// `progress` is null while the pull is still listing the manifest — real work with
// no denominator yet — so the spinner covers that stretch and the bar replaces it
// once the count exists. The alternative is a bar parked at 0%, which looks broken
// for exactly as long as the listing takes.
//
// `retrying` is the provider retrying a failed attempt on its own before the gate
// offers its button — web's gate carries the same line.
function DecryptingScreen({
  progress,
  retrying = false,
}: {
  progress: InitialSyncProgress | null;
  retrying?: boolean;
}) {
  return (
    <StyledSafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center gap-3 px-6">
        <Text className="text-center">Decrypting your links…</Text>
        {progress ? (
          <ProgressMeter
            label="Decrypting your links"
            done={progress.done}
            total={progress.total}
            valueText={initialSyncProgressLabel(progress)}
            className="w-56"
          />
        ) : (
          <ActivityIndicator size="small" />
        )}
        {/*
          A status, not ErrorText: it arrives on its own and asks nothing of the
          user — the pull resumes by itself (docs/accessibility.md, "what must
          NOT announce"). Web's twin is a `role="status"` line.
        */}
        {retrying ? (
          <Text role="status" className="text-center text-xs text-muted-foreground">
            Retrying…
          </Text>
        ) : null}
        {/*
          Standing prose, not an announcement (docs/accessibility.md, "what must
          NOT announce") — it is on screen from the first frame. This is the one
          wait in the app where the end-to-end encryption is visible rather than
          claimed, so the empty seconds carry the sentence.

          "only you, with your password" — NOT "only this device", which this
          screen is itself the counterexample to: the password unwraps the key
          (docs/account.md), so a first pull on a SECOND device is
          exactly what is being narrated here. Matches BRAND's "Bookmarks only
          you can read" (brand/brand.ts).
        */}
        <Text className="text-center text-xs text-muted-foreground">
          Your links are encrypted — only you, with your password, can read them.
        </Text>
      </View>
    </StyledSafeAreaView>
  );
}
