import * as React from 'react';
import { act, render } from '@testing-library/react-native';

import { SplashHold } from './splash-hold';

// Two one-frame facts, neither of which anything else can see. The splash is a
// native overlay: it is not in the render tree, no screen query can assert it,
// and on a device a hide that fires one beat early looks exactly like a hide that
// fires on time — the blank frame it uncovers is the bug, and it is gone before
// anyone can point at it. What IS assertable is which calls were made and in what
// order, so that is what this pins: nothing hides while the session is still
// reading, exactly one hide once it has, and a hide anyway if it never does.
//
// The last of those is the reason for the file. Every other path here degrades to
// a flash; the one where `loadSession()` never settles degrades to an app that
// never shows a screen at all, and it has no symptom in jest, no type, and no
// crash on device.

let mockStatus = 'loading';
jest.mock('@stxapps/expo-react', () => ({
  useAuth: () => ({ status: mockStatus }),
}));

const mockHideAsync = jest.fn(() => Promise.resolve());
const mockPreventAutoHideAsync = jest.fn(() => Promise.resolve(true));
jest.mock('expo-splash-screen', () => ({
  hideAsync: () => mockHideAsync(),
  preventAutoHideAsync: () => mockPreventAutoHideAsync(),
}));

function mount() {
  const view = render(<SplashHold />);
  return { ...view, advance: () => view.rerender(<SplashHold />) };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockStatus = 'loading';
  mockHideAsync.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

test('holds the splash while the session is still reading', () => {
  const { advance } = mount();

  advance();
  act(() => jest.advanceTimersByTime(1_000));

  expect(mockHideAsync).not.toHaveBeenCalled();
});

test.each(['authenticated', 'unauthenticated'])(
  'hides once the session resolves to %s',
  (status) => {
    const { advance } = mount();

    mockStatus = status;
    advance();

    expect(mockHideAsync).toHaveBeenCalledTimes(1);
  },
);

test('hides exactly once, however many renders follow', () => {
  const { advance } = mount();

  mockStatus = 'authenticated';
  advance();
  advance();
  // The sign-out teardown reaches this component like any other status change;
  // the latch is what keeps it from re-hiding a splash that is long gone.
  mockStatus = 'ending';
  advance();
  act(() => jest.advanceTimersByTime(10_000));

  expect(mockHideAsync).toHaveBeenCalledTimes(1);
});

test('hides anyway if the session read never settles', () => {
  const { advance } = mount();

  act(() => jest.advanceTimersByTime(5_000));

  expect(mockHideAsync).toHaveBeenCalledTimes(1);

  // And the status arriving late does not hide a second time.
  mockStatus = 'authenticated';
  advance();

  expect(mockHideAsync).toHaveBeenCalledTimes(1);
});

test('renders nothing', () => {
  const { toJSON } = mount();

  expect(toJSON()).toBeNull();
});
