import {
  coerceThemeState,
  DEFAULT_THEME,
  msUntilNextThemeSwitch,
  resolveTheme,
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
