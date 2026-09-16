import { useCallback, useEffect, useRef } from 'react';
import * as SplashScreen from 'expo-splash-screen';

import { useAuth } from '@stxapps/expo-react';

// Holds the NATIVE splash (expo-splash-screen, configured in app.config.ts — the
// mark on #ffffff, or its dark pair on #0a0a0a) over the frames the app has
// nothing to show in: from the navigator's first commit until AuthProvider's
// secure-store read resolves. It renders null in every state, always, and never
// swaps or withholds anything on screen — so it is neither a guard nor a Gate in
// the sense the rest of this folder uses those words (home-guard.tsx carries the
// split). What it decides is when a native overlay comes OFF, which is why it is
// a Hold and why it sits beside the guards rather than above them.
//
// Without it the splash comes off too early, and that was never a choice anyone
// made: expo-router hides it itself, one requestAnimationFrame after the
// NavigationContainer reports ready (`expo-router/build/global-state/router-store.js`,
// `onReady`). That is the first frame the navigator CAN paint, which is strictly
// before the session has read back — so every cold start spent the read painting
// the null branch of HomeGuard or AuthGuard with the splash already gone.
// `SplashScreen.preventAutoHideAsync()` at the top of `src/app/_layout.tsx` turns
// that automatic hide into a no-op (expo-splash-screen's internal maybe-hide
// defers to any app-level prevent), which is what leaves the `hideAsync` below as
// the only one that fires. The two halves only work as a pair: the prevent
// without this component is a splash that never lifts.
//
// It hides on the AUTH decision, not on first content. For a signed-in user the
// <Redirect> to /links, the locks read and the store's first-sync flag all still
// land after the splash is gone — but those are local reads of a flag apiece,
// while the long pole being covered here is the secure-store read (plus, on
// Android, a keystore round trip on a cold process). What those few remaining
// frames paint is the other half of this fix and lives in `_layout.tsx`: the root
// navigator carries `--color-background` as its theme background, so a frame with
// no content is bg-background rather than react-navigation's default light grey.
// Gating the hide on more than auth would mean reaching into providers that only
// exist under `(app)` — a guest never mounts them — so this stops at the seam
// every launch shares.
//
// The timeout is not a nicety. A splash that never hides is an app that never
// starts: no error, no screen, nothing to tap. So the hide fires on the auth flip
// OR at FALLBACK_MS, whichever comes first, it is latched so the second one is a
// no-op, and `hideAsync`'s rejection is swallowed rather than left to escape.
// Losing the hold early is cosmetic; failing to hide is a brick.
const FALLBACK_MS = 5000;

export function SplashHold() {
  const { status } = useAuth();
  // Latch, not state: hiding twice is harmless but re-rendering for it is noise,
  // and both callers below race on a cold start.
  const hiddenRef = useRef(false);

  const hide = useCallback(() => {
    if (hiddenRef.current) return;
    hiddenRef.current = true;
    SplashScreen.hideAsync().catch(() => {
      // A native call on an overlay that may already be gone. Either way the
      // splash is not in the way any more, so there is nothing to recover.
    });
  }, []);

  useEffect(() => {
    // 'ending' can't reach this on a launch — the flip out of 'loading' happens
    // once per process — so any status but 'loading' means the decision is in.
    if (status === 'loading') return;
    hide();
  }, [status, hide]);

  // Armed once at mount, cleared on the first hide's re-render path by unmount
  // only — the latch is what makes a late fire harmless.
  useEffect(() => {
    const timer = setTimeout(hide, FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [hide]);

  return null;
}
