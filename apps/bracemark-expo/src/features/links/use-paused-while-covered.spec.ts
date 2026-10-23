// The links section's live reads pause while another screen covers it
// (use-paused-while-covered.ts). Two ways this goes wrong, both silent: a pause
// that never lifts leaves the links screen showing stale rows after Settings
// closes, with nothing to say why; and a pause taken on BLUR instead of on the
// disappear would also stop the rows behind an iOS pageSheet (`resume`), which
// stay on screen.

import { act, renderHook } from '@testing-library/react-native';

import { usePausedWhileCovered } from './use-paused-while-covered';

type Listener = (event: { data: { closing: boolean } }) => void;
const mockListeners = new Map<string, Set<Listener>>();

jest.mock('expo-router', () => ({
  useNavigation: () => ({
    addListener: (type: string, callback: Listener) => {
      const listeners = mockListeners.get(type) ?? new Set<Listener>();
      mockListeners.set(type, listeners);
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  }),
}));

function emit(type: string, closing = false): void {
  act(() => {
    for (const listener of mockListeners.get(type) ?? []) listener({ data: { closing } });
  });
}

beforeEach(() => mockListeners.clear());

it('is not paused while the links screen is showing', () => {
  const { result } = renderHook(() => usePausedWhileCovered());

  expect(result.current).toBe(false);
});

it('pauses once the screen has disappeared under a pushed one', () => {
  const { result } = renderHook(() => usePausedWhileCovered());

  emit('transitionStart', true);
  expect(result.current).toBe(false); // still sliding out: on screen

  emit('transitionEnd', true);
  expect(result.current).toBe(true);
});

it('resumes as soon as the screen starts to reappear', () => {
  const { result } = renderHook(() => usePausedWhileCovered());
  emit('transitionEnd', true);

  emit('transitionStart', false);

  expect(result.current).toBe(false);
});

it('pauses again when a back-swipe is cancelled', () => {
  const { result } = renderHook(() => usePausedWhileCovered());
  emit('transitionEnd', true);
  emit('transitionStart', false);

  emit('transitionEnd', true);

  expect(result.current).toBe(true);
});

it('resumes on focus even with no appear event before it', () => {
  const { result } = renderHook(() => usePausedWhileCovered());
  emit('transitionEnd', true);

  emit('focus');

  expect(result.current).toBe(false);
});

it('stops listening on unmount', () => {
  const { unmount } = renderHook(() => usePausedWhileCovered());

  unmount();

  expect([...mockListeners.values()].every((set) => set.size === 0)).toBe(true);
});
