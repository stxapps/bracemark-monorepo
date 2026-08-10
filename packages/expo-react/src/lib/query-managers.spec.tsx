import { AppState, AppStateStatus } from 'react-native';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react-native';

import { useQueryManagers } from './query-managers';

type NetInfoListener = (state: { isConnected: boolean | null }) => void;

const mockNetInfoListeners: NetInfoListener[] = [];
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: {
    addEventListener: (listener: NetInfoListener) => {
      mockNetInfoListeners.push(listener);
      return jest.fn();
    },
  },
}));

afterEach(() => {
  mockNetInfoListeners.length = 0;
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
  jest.restoreAllMocks();
});

test('wires onlineManager to NetInfo connectivity', () => {
  renderHook(() => useQueryManagers());

  expect(mockNetInfoListeners).toHaveLength(1);

  mockNetInfoListeners[0]({ isConnected: false });
  expect(onlineManager.isOnline()).toBe(false);

  mockNetInfoListeners[0]({ isConnected: true });
  expect(onlineManager.isOnline()).toBe(true);
});

test('wires focusManager to AppState changes', () => {
  let appStateListener: ((status: AppStateStatus) => void) | undefined;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListener = listener;
    return { remove: jest.fn() } as never;
  });

  renderHook(() => useQueryManagers());

  expect(appStateListener).toBeDefined();

  appStateListener?.('background');
  expect(focusManager.isFocused()).toBe(false);

  appStateListener?.('active');
  expect(focusManager.isFocused()).toBe(true);
});

test('removes the AppState subscription on unmount', () => {
  const remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation(() => ({ remove }) as never);

  const { unmount } = renderHook(() => useQueryManagers());
  unmount();

  expect(remove).toHaveBeenCalled();
});
