import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { InitialSyncProgress } from '@stxapps/shared';

import { Text } from './ui/text';
import { InitialSyncGate } from './initial-sync-gate';

let mockStoreStatus = 'ready';
let mockProgress: InitialSyncProgress | null = null;
let mockSessionState: 'active' | 'expired' = 'active';
let mockLastError: string | null = null;
const mockRetryInitialSync = jest.fn();

jest.mock('@stxapps/expo-react', () => ({
  useSync: () => ({
    storeStatus: mockStoreStatus,
    initialSyncProgress: mockProgress,
    retryInitialSync: mockRetryInitialSync,
    lastError: mockLastError,
  }),
  useAuth: () => ({ username: 'alice', sessionState: mockSessionState }),
  usePendingChangesCount: () => 0,
  useSignOut: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

function mount() {
  const view = render(
    <InitialSyncGate>
      <Text>The app</Text>
    </InitialSyncGate>,
  );
  return {
    ...view,
    advance: () =>
      view.rerender(
        <InitialSyncGate>
          <Text>The app</Text>
        </InitialSyncGate>,
      ),
  };
}

const appIsShowing = () => screen.queryByText('The app') !== null;
const decryptingIsShowing = () => screen.queryByText('Decrypting your links…') !== null;

beforeEach(() => {
  jest.useFakeTimers();
  mockStoreStatus = 'ready';
  mockProgress = null;
  mockSessionState = 'active';
  mockLastError = null;
  mockRetryInitialSync.mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

test('renders the app once the local store is ready', () => {
  mount();

  expect(appIsShowing()).toBe(true);
});

// An EXPIRED session caught this device's first sync mid-way (docs/sessions.md): not
// the "Couldn’t sync" error — nothing failed, and a retry would only earn the same
// answer — but the resume.
test('offers a sign-in, not a retry, when an expired session holds up the first sync', () => {
  mockStoreStatus = 'error';
  mockSessionState = 'expired';
  mockLastError = 'Signing in again will finish setting up this device.';

  mount();

  expect(appIsShowing()).toBe(false);
  expect(screen.getByText('Sync is paused')).toBeTruthy();
  expect(screen.getByText('Sign in to resume')).toBeTruthy();
  expect(screen.queryByText('Try again')).toBeNull();
  expect(screen.queryByText('Couldn’t sync your links.')).toBeNull();
});

test('shows neither the app nor a loading screen while checking the local flag', () => {
  mockStoreStatus = 'checking';
  mount();

  expect(appIsShowing()).toBe(false);
  expect(decryptingIsShowing()).toBe(false);
});

test('a returning visit goes directly from checking to the app', () => {
  mockStoreStatus = 'checking';
  const { advance } = mount();

  mockStoreStatus = 'ready';
  act(advance);

  expect(decryptingIsShowing()).toBe(false);
  expect(appIsShowing()).toBe(true);
});

test('holds a first-sync screen for its minimum once it has appeared', () => {
  mockStoreStatus = 'checking';
  const { advance } = mount();

  mockStoreStatus = 'syncing-initial';
  act(advance);
  mockStoreStatus = 'ready';
  act(advance);

  expect(decryptingIsShowing()).toBe(true);
  expect(appIsShowing()).toBe(false);

  act(() => jest.advanceTimersByTime(500));
  expect(appIsShowing()).toBe(true);
});

test('releases immediately when the first pull already outlasted the floor', () => {
  mockStoreStatus = 'checking';
  const { advance } = mount();

  mockStoreStatus = 'syncing-initial';
  act(advance);
  act(() => jest.advanceTimersByTime(5_000));
  mockStoreStatus = 'ready';
  act(advance);

  expect(appIsShowing()).toBe(true);
});

test('uses an indeterminate wait while the initial pull has no total yet', () => {
  mockStoreStatus = 'syncing-initial';
  mount();

  expect(decryptingIsShowing()).toBe(true);
  expect(screen.queryByLabelText('Decrypting your links')).toBeNull();
});

test('exposes determinate progress as one non-live progressbar', () => {
  mockStoreStatus = 'syncing-initial';
  mockProgress = { done: 40, total: 200 };
  mount();

  const bar = screen.getByLabelText('Decrypting your links');
  expect(bar.props.role).toBe('progressbar');
  expect(bar.props['aria-valuemin']).toBe(0);
  expect(bar.props['aria-valuemax']).toBe(200);
  expect(bar.props['aria-valuenow']).toBe(40);
  expect(bar.props['aria-valuetext']).toBe('40 of 200 items');
  expect(bar.props['aria-live']).toBeUndefined();

  expect(screen.getByText('40 of 200 items', { includeHiddenElements: true })).toBeTruthy();
  expect(screen.UNSAFE_getByProps({ 'aria-hidden': true })).toBeTruthy();
});

// The engine only reports a positive total, but the meter is a package boundary
// away from that guarantee and the failure mode is a NaN fill: a zero total
// draws an empty track that claims no value.
test('turns a zero total into an empty track that claims no value', () => {
  mockStoreStatus = 'syncing-initial';
  mockProgress = { done: 0, total: 0 };
  mount();

  const bar = screen.getByLabelText('Decrypting your links');
  expect(bar.props['aria-valuenow']).toBeUndefined();
  expect(bar.children).toHaveLength(0);
  expect(screen.queryByText(/NaN/, { includeHiddenElements: true })).toBeNull();
});

test('announces a first-sync failure, reassures, and retries without leaking the app', () => {
  mockStoreStatus = 'error';
  mount();

  expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t sync your links.');
  expect(screen.getByText(/picks up where it left off/)).toBeTruthy();
  expect(appIsShowing()).toBe(false);

  fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
  expect(mockRetryInitialSync).toHaveBeenCalledTimes(1);
});

test('a retry gets a fresh minimum-visible floor', () => {
  mockStoreStatus = 'checking';
  const { advance } = mount();

  mockStoreStatus = 'syncing-initial';
  act(advance);
  act(() => jest.advanceTimersByTime(5_000));
  mockStoreStatus = 'error';
  act(advance);

  mockStoreStatus = 'checking';
  act(advance);
  mockStoreStatus = 'syncing-initial';
  act(advance);
  mockStoreStatus = 'ready';
  act(advance);

  expect(appIsShowing()).toBe(false);
  act(() => jest.advanceTimersByTime(500));
  expect(appIsShowing()).toBe(true);
});
