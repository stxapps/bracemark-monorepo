import * as React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { KeptCopiesGroup } from './kept-copies-group';

// Settings → Link previews → Kept copies on the phone (its header has the reasoning).
// A switch exists only where it changes something on THIS device:
//   - the images switch on both platforms (it qualifies every copy, the capture
//     screen's included);
//   - the on-save switch on iOS only — its one effect on a phone is a share from
//     Safari, and an Android share carries no copy;
//   - no screenshot switch anywhere: the phone takes none.

let mockKeptCopies = true;
let mockMode = 'saves';
const mockSetKeepOnSave = jest.fn(async (_patch: unknown) => undefined);
const mockShowPaywall = jest.fn();

jest.mock('@stxapps/expo-react', () => ({
  useEntitlements: () => ({ entitlements: { keptCopies: mockKeptCopies } }),
  useSettings: () => ({
    keepOnSave: { readMode: true, readModeImages: true, screenshot: false },
    deviceExtractionMode: mockMode,
  }),
  useSettingMutations: () => ({ setKeepOnSave: mockSetKeepOnSave }),
}));
jest.mock('../../contexts/paywall-provider', () => ({
  usePaywall: () => ({ show: mockShowPaywall }),
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
  mockShowPaywall.mockClear();
});

test('iOS: the on-save switch and the images switch — and no screenshot switch', () => {
  Platform.OS = 'ios';
  render(<KeptCopiesGroup />);
  expect(screen.getByTestId('keep-read-mode-on-save')).toBeTruthy();
  expect(screen.getByTestId('keep-read-mode-images')).toBeTruthy();
  expect(screen.queryByText(/screenshot/i)).toBeNull();
});

// ⚠ On Android nothing a save does keeps a copy, so the switch would change nothing on
// the device holding it — while still changing the browser extension's saves.
test('Android: only the images switch', () => {
  Platform.OS = 'android';
  render(<KeptCopiesGroup />);
  expect(screen.queryByTestId('keep-read-mode-on-save')).toBeNull();
  expect(screen.getByTestId('keep-read-mode-images')).toBeTruthy();
  expect(screen.queryByText(/Safari/)).toBeNull();
});

test('a switch writes the synced setting', () => {
  Platform.OS = 'ios';
  render(<KeptCopiesGroup />);
  fireEvent(screen.getByTestId('keep-read-mode-on-save'), 'valueChange', false);
  fireEvent(screen.getByTestId('keep-read-mode-images'), 'valueChange', false);
  expect(mockSetKeepOnSave).toHaveBeenNthCalledWith(1, { readMode: false });
  expect(mockSetKeepOnSave).toHaveBeenNthCalledWith(2, { readModeImages: false });
});

test('free: the switches show off and disabled, beside the upgrade', () => {
  Platform.OS = 'ios';
  mockKeptCopies = false;
  render(<KeptCopiesGroup />);
  for (const id of ['keep-read-mode-on-save', 'keep-read-mode-images']) {
    const control = screen.getByTestId(id);
    expect(control.props.value).toBe(false);
    expect(control.props.disabled).toBe(true);
  }
  fireEvent.press(screen.getByTestId('kept-copies-upgrade'));
  expect(mockShowPaywall).toHaveBeenCalledWith('keptCopies');
});

test('iOS with previews off: says a Safari share keeps its text only', () => {
  Platform.OS = 'ios';
  mockMode = 'off';
  render(<KeptCopiesGroup />);
  expect(screen.getByText(/keeps its text only/)).toBeTruthy();
});
