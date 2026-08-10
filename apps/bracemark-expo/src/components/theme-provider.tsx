// The read/apply half of the theme — the expo port of web-ui's
// `contexts/theme-provider.tsx` (the canonical doc: docs/theme.md). The SOURCE
// OF TRUTH is the settings data layer, not this provider: the user picks a mode
// (and, per device, the sync/device source) in Settings → Misc, written via
// `useSettingMutations`. This consumes the already-resolved `ThemeState` from
// `useSettings` (exactly as the links page consumes `linksLayout`), turns it
// into the rendered light/dark, and re-resolves on each mode's trigger. It
// exposes only `effectiveTheme`; read the preference itself from
// `useSettings().theme`.
//
// RN divergences from web (docs/theme.md — "per-app wiring"):
//   • Apply is `Uniwind.setTheme(...)`, not `classList.toggle('dark')` — RN has
//     no DOM class; Uniwind's runtime theme is the equivalent, and `global.css`
//     already declares the `@variant light`/`@variant dark` token sets.
//   • `system` is handed to Uniwind (`setTheme('system')`) rather than resolved
//     and pinned like web. Pinning calls `Appearance.setColorScheme(...)`, which
//     SHADOWS the OS signal — so in system mode we must leave the override clear
//     and let Uniwind's own Appearance listener track the OS. `light`/`dark`/
//     `custom` resolve to a concrete value and pin; the `Appearance.setColorScheme`
//     side effect there is a bonus — it makes `<StatusBar style="auto">` and
//     native components follow the app theme with no extra wiring.
//   • No localStorage FOUC mirror / `themeInitScript`: those exist only because a
//     browser paints before React/IndexedDB. Native has no pre-paint script and
//     no synchronous store to read mid-mount; the splash screen covers startup,
//     and Uniwind's own startup default (`system`) matches `DEFAULT_THEME`.

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance } from 'react-native';
import { Uniwind } from 'uniwind';

import { useSettings } from '@stxapps/expo-react';
import { type EffectiveTheme, msUntilNextThemeSwitch, resolveTheme } from '@stxapps/shared';

interface ThemeContextValue {
  /** What's actually rendered right now (light | dark). */
  effectiveTheme: EffectiveTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The active theme, already resolved across the sync/device sources by
  // useSettings (DEFAULT_THEME while the live read is still loading).
  const { theme } = useSettings();
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>('light');

  // Resolve + apply on every state change, and re-resolve on the triggers each
  // mode depends on: `system` → OS appearance change; `custom` → next crossover.
  useEffect(() => {
    const apply = () => {
      if (theme.mode === 'system') {
        // Hand system to Uniwind: it clears any override and tracks the OS, so
        // `Appearance.getColorScheme()` reports the real OS scheme here.
        Uniwind.setTheme('system');
        setEffectiveTheme(Appearance.getColorScheme() === 'dark' ? 'dark' : 'light');
        return;
      }
      // light / dark / custom — none read systemPrefersDark, so the value passed
      // is irrelevant. Pinning also drives Appearance → StatusBar follows.
      const next = resolveTheme(theme, { now: new Date(), systemPrefersDark: false });
      Uniwind.setTheme(next);
      setEffectiveTheme(next);
    };
    apply();

    // Re-resolve when the OS scheme flips (matters in `system` mode; a harmless,
    // idempotent re-apply in the others). Replaces web's matchMedia listener.
    const sub = Appearance.addChangeListener(apply);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const ms = msUntilNextThemeSwitch(theme, new Date());
      if (ms != null) {
        timer = setTimeout(
          () => {
            apply();
            schedule();
          },
          Math.max(ms, 0) + 1000, // +1s cushion so we land past the boundary
        );
      }
    };
    schedule();

    return () => {
      sub.remove();
      if (timer) clearTimeout(timer);
    };
  }, [theme]);

  // Stable reference so unrelated `useSettings` emissions (a linksLayout or
  // serverExtraction change re-renders this provider too) don't re-render every
  // consumer — only an actual light↔dark flip does.
  const value = useMemo(() => ({ effectiveTheme }), [effectiveTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a <ThemeProvider>');
  return ctx;
}
