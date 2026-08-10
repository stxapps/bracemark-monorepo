// Theme preference logic, shared by every web surface (bracemark-web, bracemark-extension).
//
// The user picks one of four *modes*; the DOM only ever needs the resolved
// light/dark result. Keeping the resolver pure and platform-agnostic lets both
// apps — and the pre-paint FOUC script — agree on the same answer.

// The four modes the user can pick. A `readonly` tuple (not a bare union) so it's
// also a runtime value: `coerceThemeState` ranges over it to validate an untrusted
// mode, and the Settings UI maps it to render one radio per mode.
export const THEME_MODES = ['light', 'dark', 'system', 'custom'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export type EffectiveTheme = 'light' | 'dark';

export interface ThemeState {
  mode: ThemeMode;
  /** Time of day the light theme turns on in `custom` mode, "HH:mm" 24h. */
  lightStart: string;
  /** Time of day the dark theme turns on in `custom` mode, "HH:mm" 24h. */
  darkStart: string;
}

export const DEFAULT_THEME: ThemeState = {
  mode: 'system',
  lightStart: '06:00',
  darkStart: '19:00',
};

/** Key used in localStorage and browser.storage. */
export const THEME_STORAGE_KEY = 'bracemark-theme';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Resolve a preference into the theme to actually render. `system`/`custom`
 * need outside facts (the OS preference, the current time), so the caller
 * supplies them — keeping this function pure and easy to test.
 */
export function resolveTheme(
  state: ThemeState,
  ctx: { now: Date; systemPrefersDark: boolean },
): EffectiveTheme {
  if (state.mode === 'light' || state.mode === 'dark') return state.mode;
  if (state.mode === 'system') return ctx.systemPrefersDark ? 'dark' : 'light';

  // custom: the dark window may wrap past midnight (e.g. dark 19:00 → light 06:00).
  const cur = ctx.now.getHours() * 60 + ctx.now.getMinutes();
  const light = toMinutes(state.lightStart);
  const dark = toMinutes(state.darkStart);
  const isDark = light <= dark ? cur >= dark || cur < light : cur >= dark && cur < light;
  return isDark ? 'dark' : 'light';
}

/**
 * Milliseconds until the next custom-mode crossover, so a provider can schedule
 * a single timer to re-resolve at exactly the right moment. `null` for every
 * other mode (nothing time-based to wait for).
 */
export function msUntilNextThemeSwitch(state: ThemeState, now: Date): number | null {
  if (state.mode !== 'custom') return null;

  const cur = now.getHours() * 60 + now.getMinutes();
  const deltas = [toMinutes(state.lightStart), toMinutes(state.darkStart)].map(
    // 0 means we're exactly on a boundary now; wait a full day for that one.
    (t) => (t - cur + 1440) % 1440 || 1440,
  );
  return Math.min(...deltas) * 60_000 - now.getSeconds() * 1000 - now.getMilliseconds();
}

/** Validate/normalize an untrusted value (from storage) into a ThemeState. */
export function coerceThemeState(value: unknown): ThemeState {
  if (typeof value !== 'object' || value === null) return { ...DEFAULT_THEME };

  const v = value as Record<string, unknown>;
  return {
    mode: THEME_MODES.includes(v.mode as ThemeMode) ? (v.mode as ThemeMode) : DEFAULT_THEME.mode,
    lightStart:
      typeof v.lightStart === 'string' && TIME_RE.test(v.lightStart)
        ? v.lightStart
        : DEFAULT_THEME.lightStart,
    darkStart:
      typeof v.darkStart === 'string' && TIME_RE.test(v.darkStart)
        ? v.darkStart
        : DEFAULT_THEME.darkStart,
  };
}

/**
 * A self-contained IIFE (as a string) that sets the `.dark` class on <html>
 * before first paint. Inline it synchronously in <head>/top-of-<body> so the
 * page never flashes the wrong theme. Mirrors `resolveTheme` in plain ES5.
 */
export function themeInitScript(storageKey: string = THEME_STORAGE_KEY): string {
  const k = JSON.stringify(storageKey);
  const dl = JSON.stringify(DEFAULT_THEME.lightStart);
  const dd = JSON.stringify(DEFAULT_THEME.darkStart);
  return (
    `(function(){try{` +
    `var raw=localStorage.getItem(${k});` +
    `var s=raw?JSON.parse(raw):null;` +
    `var m=s&&s.mode?s.mode:'system';` +
    `var sd=window.matchMedia('(prefers-color-scheme: dark)').matches;` +
    `var d;` +
    `if(m==='dark'){d=true;}` +
    `else if(m==='light'){d=false;}` +
    `else if(m==='custom'){` +
    `var n=new Date();var c=n.getHours()*60+n.getMinutes();` +
    `var t=function(x){var p=String(x).split(':');return (+p[0])*60+(+p[1]);};` +
    `var ls=t((s&&s.lightStart)||${dl}),ds=t((s&&s.darkStart)||${dd});` +
    `d=ls<=ds?(c>=ds||c<ls):(c>=ds&&c<ls);` +
    `}else{d=sd;}` +
    `document.documentElement.classList.toggle('dark',!!d);` +
    `}catch(e){}})();`
  );
}
