import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

import { useSync } from '@stxapps/expo-react';
import { type InitialSyncProgress, initialSyncProgressLabel } from '@stxapps/shared';

import { Button } from './ui/button';
import { Text } from './ui/text';
import { ErrorText } from './error-text';

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
// The screen shows a real COUNT rather than a percentage or a bare spinner — the
// reasoning is on the web twin, which is the canonical copy. The one divergence is
// the ActivityIndicator: it stands in for the bar while the pull is still listing
// (native expects a spinner where web is happy with a line of text), and the two
// never show at once.

// How long the first-sync screen stays up once shown, so a fast pull can't flash
// it. Only relevant to 'syncing-initial' (a network pull); 'checking' never shows
// a screen at all, so it needs no such floor.
const MIN_SCREEN_MS = 500;

export function InitialSyncGate({ children }: { children: ReactNode }) {
  const { storeStatus, initialSyncProgress, retryInitialSync } = useSync();

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
    return <DecryptingScreen progress={initialSyncProgress} />;
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
function DecryptingScreen({ progress }: { progress: InitialSyncProgress | null }) {
  return (
    <StyledSafeAreaView className="flex-1 bg-background">
      <View className="flex-1 items-center justify-center gap-3 px-6">
        <Text>Decrypting your links…</Text>
        {progress ? <SyncProgressBar progress={progress} /> : <ActivityIndicator size="small" />}
        {/*
          Standing prose, not an announcement (docs/accessibility.md, "what must
          NOT announce") — it is on screen from the first frame. This is the one
          wait in the app where the end-to-end encryption is visible rather than
          claimed, so the empty seconds carry the sentence.

          "only you, with your password" — NOT "only this device", which this
          screen is itself the counterexample to: the key derives from the
          password (docs/account.md), so a first pull on a SECOND device is
          exactly what is being narrated here. Matches BRAND's "Bookmarks only
          you can read" (stores/listing-copy.ts).
        */}
        <Text className="text-center text-xs text-muted-foreground">
          Your links are encrypted — only you, with your password, can read them.
        </Text>
      </View>
    </StyledSafeAreaView>
  );
}

function SyncProgressBar({ progress }: { progress: InitialSyncProgress }) {
  const { done, total } = progress;
  const label = initialSyncProgressLabel(progress);
  // The engine only reports a positive total, but this component is a package
  // boundary away from that guarantee, and the failure mode is a NaN width.
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <View className="w-56 items-center gap-2">
      {/*
        `role` + the four `aria-value*` props are the RN-supported spelling (they
        map onto accessibilityRole/accessibilityValue — docs/accessibility.md, the
        note on ARIA-shaped props), so `aria-valuetext` really does reach VoiceOver
        and TalkBack here. It is NOT a live region and must not become one: this
        updates ~10 times a second, and announcing every tick would be the
        password-strength mistake multiplied by a thousand.
      */}
      <View
        role="progressbar"
        aria-label="Decrypting your links"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={label}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <View className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </View>
      {/*
        Hidden from assistive tech because the progressbar above already announces
        this exact string as its value — left visible to it, the count is read
        twice.

        ⚠ The wrapping View is load-bearing: `aria-hidden` on the Text ITSELF does
        nothing. RN's View.js maps the prop onto `accessibilityElementsHidden` +
        `importantForAccessibility="no-hide-descendants"`, but its Text.js
        destructures exactly six aria props — busy, checked, disabled, expanded,
        label, selected — and `hidden` is not one of them, so on a Text the prop
        type-checks, renders, and does nothing. It is the inert-`aria-*` trap in
        docs/accessibility.md, sprung by a prop that doc's list of fourteen says is
        supported. Verified on device with `uiautomator dump --compressed` (the
        accessibility-filtered tree — the plain dump shows every view either way):
        with this wrapper the duplicate "N of 10 items" node is gone, leaving only
        the progressbar's own description.
      */}
      <View aria-hidden>
        <Text className="text-xs text-muted-foreground">{label}</Text>
      </View>
    </View>
  );
}
