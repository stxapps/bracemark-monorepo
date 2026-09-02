import {
  coerceThemeState,
  DEFAULT_THEME,
  msUntilNextThemeSwitch,
  resolveTheme,
  THEME_MODES,
  THEME_STORAGE_KEY,
  themeInitScript,
  type ThemeState,
} from './theme';

const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m, 0, 0);

describe('resolveTheme', () => {
  const base: ThemeState = { mode: 'light', lightStart: '06:00', darkStart: '19:00' };

  it('returns the fixed mode for light/dark', () => {
    expect(resolveTheme({ ...base, mode: 'light' }, { now: at(3), systemPrefersDark: true })).toBe(
      'light',
    );
    expect(resolveTheme({ ...base, mode: 'dark' }, { now: at(3), systemPrefersDark: false })).toBe(
      'dark',
    );
  });

  it('follows the OS preference for system', () => {
    expect(resolveTheme({ ...base, mode: 'system' }, { now: at(3), systemPrefersDark: true })).toBe(
      'dark',
    );
    expect(
      resolveTheme({ ...base, mode: 'system' }, { now: at(3), systemPrefersDark: false }),
    ).toBe('light');
  });

  describe('custom (dark window wraps past midnight: dark 19:00 → light 06:00)', () => {
    const custom: ThemeState = { mode: 'custom', lightStart: '06:00', darkStart: '19:00' };
    const ctx = { systemPrefersDark: false };

    it('is dark late at night and early morning', () => {
      expect(resolveTheme(custom, { now: at(23), ...ctx })).toBe('dark');
      expect(resolveTheme(custom, { now: at(2), ...ctx })).toBe('dark');
    });
    it('is light during the day', () => {
      expect(resolveTheme(custom, { now: at(6), ...ctx })).toBe('light');
      expect(resolveTheme(custom, { now: at(12), ...ctx })).toBe('light');
      expect(resolveTheme(custom, { now: at(18, 59), ...ctx })).toBe('light');
    });
    it('flips exactly at darkStart', () => {
      expect(resolveTheme(custom, { now: at(19), ...ctx })).toBe('dark');
    });
  });

  it('handles a non-wrapping window (dark 09:00 → light 21:00)', () => {
    const inverted: ThemeState = { mode: 'custom', lightStart: '21:00', darkStart: '09:00' };
    const ctx = { systemPrefersDark: false };
    expect(resolveTheme(inverted, { now: at(12), ...ctx })).toBe('dark');
    expect(resolveTheme(inverted, { now: at(23), ...ctx })).toBe('light');
    expect(resolveTheme(inverted, { now: at(3), ...ctx })).toBe('light');
  });
});

describe('msUntilNextThemeSwitch', () => {
  it('is null for non-custom modes', () => {
    expect(msUntilNextThemeSwitch({ ...DEFAULT_THEME, mode: 'system' }, at(12))).toBeNull();
  });

  it('counts down to the nearest boundary', () => {
    const custom: ThemeState = { mode: 'custom', lightStart: '06:00', darkStart: '19:00' };
    // 18:00 → darkStart (19:00) is 1h away.
    expect(msUntilNextThemeSwitch(custom, at(18))).toBe(60 * 60_000);
    // 20:00 → lightStart (06:00) is 10h away.
    expect(msUntilNextThemeSwitch(custom, at(20))).toBe(10 * 60 * 60_000);
  });

  it('lands the timer ON the boundary, not on the next whole minute', () => {
    // The boundaries are minute-resolution but `now` is not, so the delay has to
    // subtract the seconds already elapsed. Without that the timer fires up to a
    // minute early, resolveTheme still returns the OLD theme, and the provider
    // re-schedules — the user watches the theme flip late (and a shorter
    // re-schedule loop spins until the minute rolls over).
    const custom: ThemeState = { mode: 'custom', lightStart: '06:00', darkStart: '19:00' };
    const now = new Date(2026, 0, 1, 18, 30, 20, 250);
    const fires = new Date(now.getTime() + Number(msUntilNextThemeSwitch(custom, now)));
    expect(fires).toEqual(new Date(2026, 0, 1, 19, 0, 0, 0));
  });

  it('waits a full day when we are standing exactly ON a boundary', () => {
    // The one that would hang the app: at 19:00:00.000 the darkStart delta is 0,
    // so a naive modulo schedules a 0ms timer that resolves to the same theme
    // and re-schedules 0ms later, forever. The next switch from here is the
    // OTHER boundary — 06:00, eleven hours out.
    const custom: ThemeState = { mode: 'custom', lightStart: '06:00', darkStart: '19:00' };
    expect(msUntilNextThemeSwitch(custom, at(19))).toBe(11 * 60 * 60_000);
    expect(msUntilNextThemeSwitch(custom, at(6))).toBe(13 * 60 * 60_000);
  });

  it('never returns a non-positive delay, at any minute of the day', () => {
    // The general form of the case above: a 0 or negative delay is a hot loop.
    const custom: ThemeState = { mode: 'custom', lightStart: '06:00', darkStart: '19:00' };
    for (let minute = 0; minute < 1440; minute++) {
      // Number(null) is 0, so a null here fails this assertion rather than
      // needing its own — custom mode never returns one.
      expect(Number(msUntilNextThemeSwitch(custom, at(0, minute)))).toBeGreaterThan(0);
    }
  });
});

describe('coerceThemeState', () => {
  it('falls back to defaults for garbage', () => {
    expect(coerceThemeState(null)).toEqual(DEFAULT_THEME);
    expect(coerceThemeState('nope')).toEqual(DEFAULT_THEME);
    expect(coerceThemeState({ mode: 'rainbow', lightStart: '99:99' })).toEqual(DEFAULT_THEME);
  });
  it('keeps valid fields', () => {
    expect(coerceThemeState({ mode: 'custom', lightStart: '07:30', darkStart: '20:15' })).toEqual({
      mode: 'custom',
      lightStart: '07:30',
      darkStart: '20:15',
    });
  });
});

describe('themeInitScript', () => {
  // The pre-paint FOUC script is a hand-written ES5 RESTATEMENT of resolveTheme,
  // inlined as a string because it has to run before React exists. Two
  // implementations of one rule is exactly the drift a spec is for: a change to
  // resolveTheme that misses the string leaves the page painting the wrong theme
  // for a frame on every load, and nothing else in the workspace can see it.
  //
  // Run in a sandbox rather than jsdom (this project's jest is testEnvironment
  // 'node'): the script is an IIFE referencing bare globals, so passing them as
  // parameters shadows them. The stubs answer ONLY the exact storage key and the
  // exact media query, so a typo in either reads as "no preference" and shows up
  // in the agreement matrix below rather than needing its own assertion.
  const run = (
    script: string,
    env: { stored?: unknown; systemPrefersDark: boolean; now: Date; key?: string },
  ): { dark: boolean | 'untouched' } => {
    let dark: boolean | 'untouched' = 'untouched';
    const localStorage = {
      getItem: (k: string) =>
        k === (env.key ?? THEME_STORAGE_KEY) && env.stored !== undefined
          ? typeof env.stored === 'string'
            ? env.stored
            : JSON.stringify(env.stored)
          : null,
    };
    const window = {
      matchMedia: (q: string) => ({
        matches: q === '(prefers-color-scheme: dark)' ? env.systemPrefersDark : false,
      }),
    };
    const document = {
      documentElement: { classList: { toggle: (_cls: string, on: boolean) => void (dark = on) } },
    };
    class FakeDate {
      getHours() {
        return env.now.getHours();
      }
      getMinutes() {
        return env.now.getMinutes();
      }
    }
    new Function('localStorage', 'window', 'document', 'Date', script)(
      localStorage,
      window,
      document,
      FakeDate,
    );
    return { dark };
  };

  it('agrees with resolveTheme for every mode, hour and OS preference', () => {
    const script = themeInitScript();
    const windows = [
      { lightStart: '06:00', darkStart: '19:00' }, // wraps past midnight
      { lightStart: '21:00', darkStart: '09:00' }, // does not wrap
    ];
    for (const mode of THEME_MODES) {
      for (const times of windows) {
        // Minute 0 puts `now` exactly ON each boundary hour — where a < vs <=
        // slip lives, and where the two implementations are easiest to part.
        for (const hour of [0, 2, 6, 9, 12, 18, 19, 21, 23]) {
          for (const minute of [0, 30]) {
            for (const systemPrefersDark of [true, false]) {
              const state: ThemeState = { mode, ...times };
              const now = at(hour, minute);
              const { dark } = run(script, { stored: state, systemPrefersDark, now });
              expect({ mode, ...times, hour, minute, systemPrefersDark, dark }).toEqual({
                mode,
                ...times,
                hour,
                minute,
                systemPrefersDark,
                dark: resolveTheme(state, { now, systemPrefersDark }) === 'dark',
              });
            }
          }
        }
      }
    }
  });

  it('follows the OS on a first visit, with nothing in storage', () => {
    // The most common path of all — every user hits it once, and the mode has to
    // default to DEFAULT_THEME's 'system' rather than to a fixed theme.
    expect(DEFAULT_THEME.mode).toBe('system');
    const script = themeInitScript();
    expect(run(script, { systemPrefersDark: true, now: at(12) }).dark).toBe(true);
    expect(run(script, { systemPrefersDark: false, now: at(12) }).dark).toBe(false);
  });

  it('applies the custom window using the stored times, not the defaults', () => {
    const script = themeInitScript();
    const stored = { mode: 'custom', lightStart: '10:00', darkStart: '11:00' };
    // 10:30 is light under these times and dark under DEFAULT_THEME's 06:00/19:00.
    expect(run(script, { stored, systemPrefersDark: false, now: at(10, 30) }).dark).toBe(false);
  });

  it('reads the storage key it was given', () => {
    // bracemark-extension writes under its own key; a script that ignores the
    // argument would silently read nothing and fall back to the OS preference.
    const dark = { mode: 'dark', lightStart: '06:00', darkStart: '19:00' };
    expect(
      run(themeInitScript('other-key'), {
        stored: dark,
        key: 'other-key',
        systemPrefersDark: false,
        now: at(12),
      }).dark,
    ).toBe(true);
  });

  it('never throws on a corrupt or half-written stored value', () => {
    // It runs before anything can catch it, so a throw here takes out the page
    // load. Leaving the class untouched (server-rendered default) is the
    // fallback; the only hard requirement is that it not raise.
    const script = themeInitScript();
    for (const stored of ['not json', '{"mode":', '[]', '42', { mode: 'rainbow' }, { mode: 3 }]) {
      expect(() => run(script, { stored, systemPrefersDark: true, now: at(12) })).not.toThrow();
    }
  });
});
