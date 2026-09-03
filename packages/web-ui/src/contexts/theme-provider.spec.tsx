import { act, render, screen } from '@testing-library/react';

import { THEME_STORAGE_KEY, type ThemeState } from '@stxapps/shared';
import { useSettings } from '@stxapps/web-react';

import { ThemeProvider, useTheme } from './theme-provider';

// The READ/APPLY half of the theme. The preference itself is owned by the
// settings data layer and the light/dark ARITHMETIC by `@stxapps/shared` (whose
// `theme.spec.ts` pins `resolveTheme` and `msUntilNextThemeSwitch` exhaustively).
// What is only true here is the three things this provider does with that
// arithmetic's answer, and each of them fails quietly:
//
//   - it toggles `dark` on <html>, which is what every Tailwind `dark:` utility
//     in both apps keys off;
//   - it MIRRORS the resolved preference to localStorage, which is the ONLY thing
//     the synchronous pre-paint FOUC script can read — the real value lives
//     encrypted in IndexedDB and cannot be reached before paint, so a missing
//     mirror costs every visitor a flash of the wrong theme on every load;
//   - it re-resolves on the trigger each mode depends on — the OS preference for
//     `system`, a timer for `custom`. Drop either and the theme is simply correct
//     at mount and then frozen, which nobody notices until they watch a sunset.

jest.mock('@stxapps/web-react', () => ({ useSettings: jest.fn() }));

const CUSTOM: ThemeState = { mode: 'custom', lightStart: '06:00', darkStart: '19:00' };

let systemPrefersDark = false;
const mediaListeners = new Set<() => void>();

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      media: query,
      get matches() {
        return query === '(prefers-color-scheme: dark)' && systemPrefersDark;
      },
      addEventListener: (_: string, l: () => void) => mediaListeners.add(l),
      removeEventListener: (_: string, l: () => void) => mediaListeners.delete(l),
    }),
  });
});

/** The OS flipping to dark mode. */
const setSystemPrefersDark = (value: boolean) => {
  systemPrefersDark = value;
  act(() => {
    for (const l of mediaListeners) l();
  });
};

const setTheme = (theme: ThemeState) => (useSettings as jest.Mock).mockReturnValue({ theme });

function Readout() {
  return <span data-testid="effective">{useTheme().effectiveTheme}</span>;
}

const renderProvider = () =>
  render(
    <ThemeProvider>
      <Readout />
    </ThemeProvider>,
  );

const effective = () => screen.getByTestId('effective').textContent;
/** What the pre-paint FOUC script would read on the next load. */
const mirror = () => JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? 'null');
const htmlIsDark = () => document.documentElement.classList.contains('dark');

beforeEach(() => {
  jest.clearAllMocks();
  systemPrefersDark = false;
  mediaListeners.clear();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('ThemeProvider', () => {
  it.each([
    ['light' as const, false],
    ['dark' as const, true],
  ])('applies the %s preference to <html>', (mode, dark) => {
    setTheme({ ...CUSTOM, mode });

    renderProvider();

    expect(htmlIsDark()).toBe(dark);
    expect(effective()).toBe(dark ? 'dark' : 'light');
  });

  // The mirror is the FOUC script's only source. Nothing reads it back in this
  // app, so a broken write shows up as a flash on the NEXT load — in a different
  // session, after a reload, with no error anywhere.
  it('mirrors the resolved preference to localStorage for the pre-paint script', () => {
    setTheme({ ...CUSTOM, mode: 'dark' });

    renderProvider();

    expect(mirror()).toEqual({ ...CUSTOM, mode: 'dark' });
  });

  it('keeps the mirror in step when the preference changes', () => {
    setTheme({ ...CUSTOM, mode: 'dark' });
    const view = renderProvider();

    setTheme({ ...CUSTOM, mode: 'light' });
    act(() =>
      view.rerender(
        <ThemeProvider>
          <Readout />
        </ThemeProvider>,
      ),
    );

    expect(mirror().mode).toBe('light');
    expect(htmlIsDark()).toBe(false);
  });

  // A stale mirror costs one flash; a throw here would take the whole provider —
  // and with it the app — down. Private-mode and quota failures are real.
  it('still applies the theme when localStorage refuses the write', () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    setTheme({ ...CUSTOM, mode: 'dark' });

    expect(() => renderProvider()).not.toThrow();
    expect(htmlIsDark()).toBe(true);

    setItem.mockRestore();
  });

  describe('system mode', () => {
    it('follows the OS preference at mount', () => {
      systemPrefersDark = true;
      setTheme({ ...CUSTOM, mode: 'system' });

      renderProvider();

      expect(effective()).toBe('dark');
    });

    it('follows the OS preference when it changes', () => {
      setTheme({ ...CUSTOM, mode: 'system' });
      renderProvider();
      expect(effective()).toBe('light');

      setSystemPrefersDark(true);

      expect(effective()).toBe('dark');
      expect(htmlIsDark()).toBe(true);
    });

    it('stops listening once unmounted', () => {
      setTheme({ ...CUSTOM, mode: 'system' });
      const view = renderProvider();
      expect(mediaListeners.size).toBe(1);

      view.unmount();

      expect(mediaListeners.size).toBe(0);
    });
  });

  describe('custom mode', () => {
    // The crossover is the one trigger with no event behind it — a timer is the
    // whole mechanism. Without it a device left open through the evening keeps
    // whatever theme it resolved at load.
    it('flips itself at the next crossover', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date(2026, 0, 1, 18, 59, 0));
        setTheme(CUSTOM);
        renderProvider();
        expect(effective()).toBe('light');

        // One minute to darkStart, plus the provider's 1s cushion past the
        // boundary.
        act(() => jest.advanceTimersByTime(61_000));

        expect(effective()).toBe('dark');
        expect(htmlIsDark()).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    // The timer re-arms itself after each flip, so an app left open overnight
    // keeps switching rather than switching exactly once.
    it('re-arms for the crossover after that', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date(2026, 0, 1, 18, 59, 0));
        setTheme(CUSTOM);
        renderProvider();

        act(() => jest.advanceTimersByTime(61_000)); // → 19:00, dark
        expect(effective()).toBe('dark');

        act(() => jest.advanceTimersByTime(11 * 60 * 60_000)); // → 06:00, light
        expect(effective()).toBe('light');
      } finally {
        jest.useRealTimers();
      }
    });

    it('clears its timer on unmount', () => {
      jest.useFakeTimers();
      try {
        jest.setSystemTime(new Date(2026, 0, 1, 18, 59, 0));
        setTheme(CUSTOM);
        const view = renderProvider();

        view.unmount();

        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // The context is deliberately nullable with a throwing reader, rather than
  // defaulting to 'light': a consumer rendered outside the provider would
  // otherwise report a theme that has nothing to do with what is on screen.
  it('refuses to be read outside the provider', () => {
    const onError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Readout />)).toThrow(/must be used within a <ThemeProvider>/);
    } finally {
      onError.mockRestore();
    }
  });
});
