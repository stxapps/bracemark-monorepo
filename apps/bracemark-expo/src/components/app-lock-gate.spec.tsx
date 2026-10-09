import * as React from 'react';
import { useEffect } from 'react';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { render, screen } from '@testing-library/react-native';

import { useAppCovered } from '../contexts/app-covered-provider';
import { Text } from './ui/text';
import { AppLockGate } from './app-lock-gate';

let mockStatus = 'ready';
let mockAppLock = { exists: false, unlocked: false, biometric: false, lockedByHand: false };

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
  return {
    LockPane: ({ solicit = true }: { solicit?: boolean }) => (
      <>
        <MockText>Lock pane</MockText>
        <MockText>{solicit ? 'asks' : 'quiet'}</MockText>
      </>
    ),
  };
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
  mockAppLock = { exists: true, unlocked: false, biometric: false, lockedByHand: false };
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

// "Lock app" puts the pane up under the thumb that just pressed it. Left to its
// defaults the pane autofocuses — a keyboard nobody asked for — or, with
// biometric on, prompts Face ID to reopen the gate the press had just closed
// (docs/locks.md, _a hand relock does not ask to be undone_). A cold start and
// the background auto-relock are the other two ways the pane goes up, and both
// meet someone who wants in. The pane's side is lock-pane.spec.tsx.
test('the pane asks for the unlock unless the app was locked by hand', () => {
  const view = render(tree());
  expect(screen.getByText('asks')).toBeTruthy();

  mockAppLock = { ...mockAppLock, unlocked: true };
  view.rerender(tree());
  mockAppLock = { ...mockAppLock, unlocked: false, lockedByHand: true };
  view.rerender(tree());
  expect(screen.getByText('quiet')).toBeTruthy();

  mockAppLock = { ...mockAppLock, unlocked: true, lockedByHand: false };
  view.rerender(tree());
  mockAppLock = { ...mockAppLock, unlocked: false };
  view.rerender(tree());
  expect(screen.getByText('asks')).toBeTruthy();
});
