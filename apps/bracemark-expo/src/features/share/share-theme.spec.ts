// Specs for the sheet's apply step. Two things are worth pinning here: that
// `system` is HANDED to Uniwind rather than resolved (pinning it would shadow
// the OS signal — the divergence contexts/theme-provider.tsx documents), and
// that the sheet defers once the app tree has claimed the theme, which is what
// keeps an Android share from re-theming the running app it shares a process
// with.
//
// The module keeps its claim in module state, so each test loads a fresh copy.
import { Uniwind } from 'uniwind';

import type { ThemeState } from '@stxapps/shared';

const mockRead = jest.fn<ThemeState, []>();
jest.mock('@stxapps/expo-react/data/share-theme-store', () => ({
  readShareTheme: () => mockRead(),
}));

const setTheme = Uniwind.setTheme as jest.Mock;

function load(): typeof import('./share-theme') {
  let mod!: typeof import('./share-theme');
  jest.isolateModules(() => {
    mod = require('./share-theme') as typeof import('./share-theme');
  });
  return mod;
}

function pref(state: Partial<ThemeState>): ThemeState {
  return { mode: 'system', lightStart: '06:00', darkStart: '19:00', ...state };
}

beforeEach(() => {
  setTheme.mockClear();
  mockRead.mockReset();
});

it('pins a chosen light/dark preference', () => {
  mockRead.mockReturnValue(pref({ mode: 'dark' }));
  load().applyShareTheme();
  expect(setTheme).toHaveBeenCalledWith('dark');
});

it('hands `system` through instead of resolving it', () => {
  mockRead.mockReturnValue(pref({ mode: 'system' }));
  load().applyShareTheme();
  expect(setTheme).toHaveBeenCalledWith('system');
});

it('resolves `custom` against the clock at open time', () => {
  jest.useFakeTimers().setSystemTime(new Date('2026-08-11T21:00:00'));
  mockRead.mockReturnValue(pref({ mode: 'custom', lightStart: '06:00', darkStart: '19:00' }));
  load().applyShareTheme();
  expect(setTheme).toHaveBeenCalledWith('dark');
  jest.useRealTimers();
});

it('defers to the app tree once it has claimed the theme', () => {
  mockRead.mockReturnValue(pref({ mode: 'dark' }));
  const mod = load();
  mod.claimAppTheme();
  mod.applyShareTheme();
  expect(setTheme).not.toHaveBeenCalled();
  expect(mockRead).not.toHaveBeenCalled();
});
