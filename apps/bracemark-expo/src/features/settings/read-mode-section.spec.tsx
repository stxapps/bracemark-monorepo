import * as React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { PAYWALL_COPY } from '@stxapps/react';

import { ReadModeSection } from './read-mode-section';

// Settings → Read mode on the phone (its header has the reasoning).
// A switch exists only where it changes something on THIS device:
//   - the images switch on both platforms (it qualifies every copy, the capture
//     screen's included);
//   - the on-save switch on iOS only — its one effect on a phone is a share from
//     Safari, and an Android share carries no copy;
//   - no screenshot switch anywhere: the phone takes none.
// On free there are no switches at all, only the upgrade.

let mockKeptCopies = true;
let mockMode = 'saves';
const mockSetKeepOnSave = jest.fn(async (_patch: unknown) => undefined);
const mockPush = jest.fn();

jest.mock('@stxapps/expo-react', () => ({
  useEntitlements: () => ({ entitlements: { keptCopies: mockKeptCopies } }),
  useSettings: () => ({
    keepOnSave: { readMode: true, readModeOnShare: true, readModeImages: true, screenshot: false },
    deviceExtractionMode: mockMode,
  }),
  useSettingMutations: () => ({ setKeepOnSave: mockSetKeepOnSave }),
}));
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args) },
}));
// The platform Switch reads theme colours through Uniwind; the control is what's tested.
jest.mock('../../components/ui/switch', () => {
  const { Switch } = jest.requireActual('react-native') as typeof import('react-native');
  return { Switch };
});

const realOS = Platform.OS;
afterEach(() => {
  Platform.OS = realOS;
});
beforeEach(() => {
  mockKeptCopies = true;
  mockMode = 'saves';
  mockSetKeepOnSave.mockClear();
  mockPush.mockClear();
});

test('iOS: the on-save switch and the images switch — and no screenshot switch', () => {
  Platform.OS = 'ios';
  render(<ReadModeSection />);
  expect(screen.getByTestId('keep-read-mode-on-share')).toBeTruthy();
  expect(screen.getByTestId('keep-read-mode-images')).toBeTruthy();
  expect(screen.queryByText(/screenshot/i)).toBeNull();
});

// ⚠ On Android nothing a save does keeps a copy, so the switch would change nothing on
// the device holding it — while still changing the browser extension's saves.
test('Android: only the images switch', () => {
  Platform.OS = 'android';
  render(<ReadModeSection />);
  expect(screen.queryByTestId('keep-read-mode-on-share')).toBeNull();
  expect(screen.getByTestId('keep-read-mode-images')).toBeTruthy();
  expect(screen.queryByText(/Safari/)).toBeNull();
});

test('a switch writes the synced setting', () => {
  Platform.OS = 'ios';
  render(<ReadModeSection />);
  fireEvent(screen.getByTestId('keep-read-mode-on-share'), 'valueChange', false);
  fireEvent(screen.getByTestId('keep-read-mode-images'), 'valueChange', false);
  expect(mockSetKeepOnSave).toHaveBeenNthCalledWith(1, { readModeOnShare: false });
  expect(mockSetKeepOnSave).toHaveBeenNthCalledWith(2, { readModeImages: false });
});

test('free: no switches, only the upgrade, straight to Subscription', () => {
  Platform.OS = 'ios';
  mockKeptCopies = false;
  render(<ReadModeSection />);
  expect(screen.queryByTestId('keep-read-mode-on-share')).toBeNull();
  expect(screen.queryByTestId('keep-read-mode-images')).toBeNull();
  expect(screen.getByText(PAYWALL_COPY.keptCopies.title)).toBeTruthy();
  fireEvent.press(screen.getByTestId('kept-copies-upgrade'));
  expect(mockPush).toHaveBeenCalledWith('/settings/subscription');
  expect(mockSetKeepOnSave).not.toHaveBeenCalled();
});

test('iOS with previews off: says a Safari share keeps its text only', () => {
  Platform.OS = 'ios';
  mockMode = 'off';
  render(<ReadModeSection />);
  expect(screen.getByText(/keeps its text only/)).toBeTruthy();
});
