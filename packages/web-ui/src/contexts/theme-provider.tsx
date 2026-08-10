'use client';
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import {
  type EffectiveTheme,
  msUntilNextThemeSwitch,
  resolveTheme,
  THEME_STORAGE_KEY,
} from '@stxapps/shared';
import { useSettings } from '@stxapps/web-react';

// The theme's SOURCE OF TRUTH is the settings data layer, not this provider: the
// user picks a mode (and, per device, whether to follow the synced or the device
// value) in Settings, written via `useSettingMutations`. This provider is the
// read/apply half — it consumes the already-resolved `ThemeState` from `useSettings`
// (exactly as the links page consumes `linksLayout`), turns it into the light/dark
// class on <html>, and re-resolves on the triggers each mode depends on. It exposes
// only the resulting `effectiveTheme` (the rendered light/dark); the preference
// itself stays a single source of truth in `useSettings().theme` — read it there.
//
// It also MIRRORS the resolved state to localStorage under `THEME_STORAGE_KEY`. That
// mirror is what the synchronous pre-paint FOUC script reads (`themeInitScript` in
// @stxapps/shared): the synced value lives encrypted in IndexedDB and can't be read
// before paint, so localStorage stays the synchronous cache no matter which source
// is active.

interface ThemeContextValue {
  /** What's actually rendered right now (light | dark). */
  effectiveTheme: EffectiveTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // The active theme, already resolved across the sync/device sources by useSettings
  // (DEFAULT_THEME while the liveQuery is still loading on first render).
  const { theme } = useSettings();
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>('light');

  // Resolve + apply on every state change, and re-resolve on the triggers each mode
  // depends on: `system` → OS preference change; `custom` → next crossover. Also keep
  // the localStorage FOUC mirror in step with the applied state.
  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(theme));
    } catch {
      // ignore quota / privacy-mode failures — a stale mirror only costs one flash.
    }

    const apply = () => {
      const next = resolveTheme(theme, {
        now: new Date(),
        systemPrefersDark: systemPrefersDark(),
      });
      document.documentElement.classList.toggle('dark', next === 'dark');
      setEffectiveTheme(next);
    };
    apply();

    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);

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
      mq.removeEventListener('change', apply);
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
