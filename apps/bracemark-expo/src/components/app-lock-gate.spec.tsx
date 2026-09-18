import * as React from 'react';
import { useEffect } from 'react';
import { render, screen } from '@testing-library/react-native';

import { Text } from './ui/text';
import { AppLockGate } from './app-lock-gate';

let mockStatus = 'ready';
let mockAppLock = { exists: false, unlocked: false, biometric: false };

jest.mock('@stxapps/expo-react', () => ({
  useLocks: () => ({
    status: mockStatus,
    appLock: mockAppLock,
    unlockApp: jest.fn(),
    biometricAvailable: false,
    biometricLabel: '',
    unlockAppWithBiometric: jest.fn(),
  }),
  useSignOut: () => ({ isPending: false, mutate: jest.fn() }),
}));

jest.mock('./lock-pane', () => {
  const { Text: MockText } = jest.requireActual('react-native');
  return { LockPane: () => <MockText>Lock pane</MockText> };
});

let mounts = 0;
function App() {
  useEffect(() => {
    mounts++;
  }, []);
  return <Text>The app</Text>;
}

const tree = () => (
  <AppLockGate>
    <App />
  </AppLockGate>
);

beforeEach(() => {
  mounts = 0;
  mockStatus = 'ready';
  mockAppLock = { exists: true, unlocked: false, biometric: false };
});

test('a cold start behind the lock never mounts the app', () => {
  render(tree());

  expect(screen.getByText('Lock pane')).toBeTruthy();
  expect(mounts).toBe(0);
});

test('checking shows neither the app nor the pane', () => {
  mockStatus = 'checking';
  render(tree());

  expect(screen.queryByText('Lock pane')).toBeNull();
  expect(mounts).toBe(0);
});

// The regression: relocking a live app used to unmount the (app) navigator, and
// remounting it on unlock left a blank screen (LOCK-APP-002).
test('a relock hides the app without unmounting it, and the unlock shows the same instance', () => {
  const view = render(tree());
  mockAppLock = { ...mockAppLock, unlocked: true };
  view.rerender(tree());
  expect(mounts).toBe(1);
  expect(screen.queryByText('Lock pane')).toBeNull();

  mockAppLock = { ...mockAppLock, unlocked: false };
  view.rerender(tree());
  expect(screen.getByText('Lock pane')).toBeTruthy();
  expect(screen.getByText('The app', { includeHiddenElements: true })).toBeTruthy();
  expect(screen.queryByText('The app')).toBeNull();

  mockAppLock = { ...mockAppLock, unlocked: true };
  view.rerender(tree());
  expect(screen.queryByText('Lock pane')).toBeNull();
  expect(screen.getByText('The app')).toBeTruthy();
  expect(mounts).toBe(1);
});
