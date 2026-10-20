'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

import { SESSION_COPY } from '@stxapps/react';
import { type InitialSyncProgress, initialSyncProgressLabel } from '@stxapps/shared';
import { useAuth, useSync } from '@stxapps/web-react';
import { ProgressMeter } from '@stxapps/web-ui/components/progress-meter';

import { SyncPausedActions } from './sync-paused-notice';

// Renders the app subtree only once the local store is usable; otherwise shows an
// in-route loading/error screen. This is a CONTENT SWAP, not a redirect: the
// "decrypting" state is a loading phase of /links (etc.), not a place of its own,
// so there's no /sync route and no history entry — the layout still owns the
// children, we just hold them back until 'ready'.
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
// The screen shows a real COUNT beside its bar and percent, not a bare spinner,
// because the engine hands it an honest denominator: the pull lists every file
// before it fetches anything, so it knows exactly how many blobs it is about to
// decrypt (see InitialSyncProgress). The count is the number that matters. It
// EXPLAINS the wait — someone with a large library learns why it takes twenty
// seconds, where a percentage alone just sits there — and a climbing integer is
// better evidence of life than a bar, since a bar that pauses reads as hung while
// a counter that moves still reads as working. The percent rides beside it as the
// glanceable half (web-ui's ProgressMeter, the drawing every sync readout shares).
// What it must never become is a bar with an invented denominator: this pull is
// resumable and blocking, and a fake percentage on the one screen that is only
// about trust is a bad trade.

// How long the first-sync screen stays up once shown, so a fast pull can't flash
// it. Only relevant to 'syncing-initial' (a network pull); 'checking' never shows
// a screen at all, so it needs no such floor.
const MIN_SCREEN_MS = 500;

export function InitialSyncGate({ children }: { children: ReactNode }) {
  const { storeStatus, initialSyncProgress, initialSyncRetrying, retryInitialSync, lastError } =
    useSync();
  const { sessionState } = useAuth();

  // No-flash: 'checking' is a single IndexedDB read of the first-sync flag and
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
  // The session EXPIRED before this device's first sync finished (docs/sessions.md).
  // Nothing failed and nothing was lost — the pull resumes where it stopped — but
  // the store isn't complete, so the gate stays closed and offers the one thing
  // that finishes it. Status, not alert: the user didn't cause it.
  if (storeStatus === 'error' && sessionState === 'expired') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 safe-area">
        <div role="status" className="flex flex-col items-center gap-1">
          <p className="text-sm font-medium">{SESSION_COPY.paused.title}</p>
          <p className="max-w-xs text-center text-xs text-muted-foreground">{lastError}</p>
        </div>
        <SyncPausedActions align="center" />
      </div>
    );
  }

  if (storeStatus === 'error') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 safe-area">
        {/*
          `role="alert"` on the WRAPPER, not on the first line alone: this message
          mounts as the result of the user signing in (docs/accessibility.md, "an
          error that appears must announce"), and the reassurance under it is part
          of what needs saying — a screen-reader user who hears only "couldn't
          sync" has no idea whether pressing the button starts over. The bare `<p
          role="alert">` in that doc's table is the same carrier, one element up.
        */}
        <div role="alert" className="flex flex-col items-center gap-1">
          <p className="text-sm text-destructive">Couldn’t sync your links.</p>
          {/*
            The pull is resumable — storeDownloads skips every path already stored,
            so a retry re-fetches only the remainder — but nothing on screen said
            so, which is what makes a user sit through a stalled first sync afraid
            to close the tab. Cheaper reassurance than any animation.
          */}
          <p className="max-w-xs text-center text-xs text-muted-foreground">
            Nothing was lost — trying again picks up where it left off.
          </p>
        </div>
        <button onClick={retryInitialSync} className="underline">
          Try again
        </button>
      </div>
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
  // flicking back to the counter-less state for the last few hundred ms.
  if (shownAtRef.current !== null && !released) {
    return <DecryptingScreen progress={initialSyncProgress} />;
  }

  return children;
}

// `progress` is null while the pull is still listing the manifest — real work with
// no denominator yet — so the screen renders its headline alone and grows the bar
// underneath once the count exists. That is a deliberate two-phase screen, not a
// loading state that forgot its spinner: the alternative is a bar parked at 0%,
// which looks broken for exactly as long as the listing takes.
//
// `retrying` is the provider retrying a failed attempt on its own (three times, a
// few seconds apart — @stxapps/shared runInitialSyncWithRetries) before the gate
// offers its button. The count restarts with each attempt, at what is left.
function DecryptingScreen({
  progress,
  retrying = false,
}: {
  progress: InitialSyncProgress | null;
  retrying?: boolean;
}) {
  return (
    // `safe-area` on the same element as the height, like every other
    // full-screen surface here — bracemark-web has no blanket wrapper to inherit
    // it from (inner-layout.tsx, docs/safe-area.md). `dvh` for the same reason
    // every other full-height box in this app uses it (links/page.tsx).
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 safe-area">
      <p>Decrypting your links…</p>
      {progress ? (
        <ProgressMeter
          label="Decrypting your links"
          done={progress.done}
          total={progress.total}
          valueText={initialSyncProgressLabel(progress)}
          className="w-56"
        />
      ) : null}
      {/*
        A polite status, not an alert (docs/accessibility.md, "what must NOT
        announce"): it arrives without the user doing anything, and nothing is
        wrong that they need to act on — the pull resumes by itself. So it waits
        for a pause, the way the username verdict does.
      */}
      {retrying ? (
        <p role="status" className="text-xs text-muted-foreground">
          Retrying…
        </p>
      ) : null}
      {/*
        Standing prose, not an announcement (docs/accessibility.md, "what must NOT
        announce") — it is on screen from the first paint. This is the one wait in
        the app where the end-to-end encryption is visible rather than claimed, so
        the empty seconds carry the sentence instead of a bigger spinner.

        "only you, with your password" — NOT "only this device", which this screen
        is itself the counterexample to: the password unwraps the key
        (docs/account.md), so a first pull on a SECOND device is exactly what is
        being narrated here. The key is not held by the device, which is the
        whole reason the second device can get at it at all. It expands BRAND's
        "Links encrypted on your device" (brand/brand.ts), and the password
        clause is what makes the wait legible rather than just reassuring.
      */}
      <p className="max-w-xs text-center text-xs text-muted-foreground">
        Your links are encrypted — only you, with your password, can read them.
      </p>
    </div>
  );
}
