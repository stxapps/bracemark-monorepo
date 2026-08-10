'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';

import { useSync } from '@stxapps/web-react';

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

// How long the first-sync screen stays up once shown, so a fast pull can't flash
// it. Only relevant to 'syncing-initial' (a network pull); 'checking' never shows
// a screen at all, so it needs no such floor.
const MIN_SCREEN_MS = 500;

export function InitialSyncGate({ children }: { children: ReactNode }) {
  const { storeStatus, retryInitialSync } = useSync();

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
  if (storeStatus === 'error') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 safe-area">
        <p>Couldn’t sync your links.</p>
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
    return <DecryptingScreen />;
  }

  // 'ready' — but if the first-sync screen showed and hasn't met its floor yet,
  // keep it up for the remainder before swapping in the app.
  if (shownAtRef.current !== null && !released) return <DecryptingScreen />;

  return children;
}

function DecryptingScreen() {
  return (
    // `safe-area` on the same element as the height, like every other
    // full-screen surface here — bracemark-web has no blanket wrapper to inherit
    // it from (inner-layout.tsx, docs/safe-area.md). `dvh` for the same reason
    // every other full-height box in this app uses it (links/page.tsx).
    <div className="flex min-h-dvh flex-col items-center justify-center safe-area">
      <p>Decrypting your links…</p>
    </div>
  );
}
