// The share sheet's half of the theme (docs/theme.md — _the share sheet_): read
// the preference the app mirrored for us and hand it to Uniwind, once, on the
// sheet's first render.
//
// This is `components/theme-provider.tsx`'s apply step and nothing else — no
// `useSettings` (the sheet has no store), no `effectiveTheme` context (nothing
// under it reads one; `components/ui/input.tsx` gets the keyboard appearance
// from `useUniwind()`), and no re-resolve triggers: Uniwind's own `Appearance`
// listener still covers an OS flip, and a `custom` crossover cannot land inside
// the three seconds this surface exists. The `system` branch is the same
// divergence the provider documents — hand `'system'` to Uniwind rather than
// resolving and pinning, so the OS override stays clear and its listener tracks
// the device.
//
// WHY THE OWNERSHIP FLAG. Android's share activity runs in the app's process
// and shares its warm React host (ShareActivity.kt), so when the app has
// already mounted, `ThemeProvider` has ALREADY pinned Uniwind — and pinning
// calls `Appearance.setColorScheme`, which is process-wide. Applying a second
// time from here would be a no-op in the normal case and, if the mirror were
// ever stale (a write that failed), would change the RUNNING APP's theme from a
// sheet floating over another app — with no path back, since the provider's
// effect re-runs on `theme` changes only. So the app claims ownership as it
// applies, and this defers to it. The flag is per-JS-context, which is exactly
// the grain that matters: the iOS extension is a separate process, so it never
// sees a claim and always reads the mirror.

import { Uniwind } from 'uniwind';

// A FILE, not the barrel — this module is on the iOS extension's critical path
// (share-root.tsx's header). `@stxapps/shared` is exempt from that rule and
// share-screen.tsx already imports it: it is pure, and `resolveTheme` is the
// same resolver every other surface runs.
import { readShareTheme } from '@stxapps/expo-react/data/share-theme';
import { resolveTheme } from '@stxapps/shared';

let appOwnsTheme = false;

// Called by the app's ThemeProvider as it applies: in this JS context the app
// tree is the authority on the theme, and the sheet must not touch it.
export function claimAppTheme(): void {
  appOwnsTheme = true;
}

export function applyShareTheme(): void {
  if (appOwnsTheme) return;
  const state = readShareTheme();
  if (state.mode === 'system') {
    Uniwind.setTheme('system');
    return;
  }
  // light / dark / custom — none reads systemPrefersDark (the provider's note),
  // so the value passed is irrelevant.
  Uniwind.setTheme(resolveTheme(state, { now: new Date(), systemPrefersDark: false }));
}
