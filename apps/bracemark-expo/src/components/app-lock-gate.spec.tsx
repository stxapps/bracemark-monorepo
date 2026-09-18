import * as React from 'react';
import { useEffect } from 'react';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { render, screen } from '@testing-library/react-native';

import { useAppCovered } from '../contexts/app-covered-provider';
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
  return (
    <>
      <Text>The app</Text>
      <Text>{useAppCovered() ? 'covered' : 'uncovered'}</Text>
    </>
  );
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

// The half of the relock the hide can't reach: overlays the app opened portal
// OUT of this subtree, and only unmount because the kit reads this flag
// (docs/locks.md, _overlays over a relock_; the kit's side is
// ui/overlays-under-relock.spec.tsx). Drop the provider, or feed it a constant,
// and a menu left open over a relock stays up over the pane — the gate spec
// above stays green, since the app itself is still hidden.
test('a relock tells what the app opened that it is covered, and the unlock that it is not', () => {
  mockAppLock = { ...mockAppLock, unlocked: true };
  const view = render(tree());
  expect(screen.getByText('uncovered')).toBeTruthy();

  mockAppLock = { ...mockAppLock, unlocked: false };
  view.rerender(tree());
  expect(screen.getByText('covered', { includeHiddenElements: true })).toBeTruthy();

  mockAppLock = { ...mockAppLock, unlocked: true };
  view.rerender(tree());
  expect(screen.getByText('uncovered')).toBeTruthy();
});

// ...and it stays covered until the pane's keyboard is down. A password unlock
// uncovers the app in the same commit the keyboard starts to hide, and an
// overlay re-presented into that commit came back laid out around a keyboard
// that then went away (the advanced-search sheet's footer, stranded a
// keyboard's height up the screen on Android).
test('an unlock keeps the app covered until the keyboard it was typed on is down', () => {
  let keyboardUp = true;
  (useKeyboardState as jest.Mock).mockImplementation((select: (s: object) => unknown) =>
    select({ isVisible: keyboardUp }),
  );
  mockAppLock = { ...mockAppLock, unlocked: true };
  const view = render(tree());
  mockAppLock = { ...mockAppLock, unlocked: false };
  view.rerender(tree());

  mockAppLock = { ...mockAppLock, unlocked: true };
  view.rerender(tree());
  expect(screen.getByText('The app')).toBeTruthy();
  expect(screen.getByText('covered')).toBeTruthy();

  keyboardUp = false;
  view.rerender(tree());
  expect(screen.getByText('uncovered')).toBeTruthy();
});
