// The Android half of the share sheet's lift (share-keyboard.ts). The failure
// it replaces was silent and one-directional: RN's KeyboardAvoidingView lifted
// the sheet correctly and then left it 74dp above the bottom of the screen once
// the keyboard closed, because `keyboardDidHide` carries a `screenY` that is
// not a position. The payloads below are the ones the Pixel 8 AVD sent.
//
// The iOS half has no case here on purpose: its number comes from a native
// module, and what is wrong with RN's own in that process cannot be reproduced
// under jest.

import { Keyboard, type KeyboardEvent, Platform } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';

import { useShareKeyboard } from './share-keyboard';

type Listener = (event: KeyboardEvent) => void;
const listeners = new Map<string, Listener>();

const SHOWN = { screenX: 0, screenY: 577.9, width: 411.43, height: 312.38 };
// `screenY` is the visible frame's HEIGHT here — the 914dp window less both
// system bars — and reads as a keyboard still 74dp up the screen.
const HIDDEN = { screenX: 0, screenY: 840, width: 411.43, height: 0 };
const NAV_BAR = 24;

function emit(type: string, endCoordinates: typeof SHOWN): void {
  act(() => listeners.get(type)?.({ endCoordinates } as KeyboardEvent));
}

beforeEach(() => {
  listeners.clear();
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Keyboard, 'addListener').mockImplementation((type, listener) => {
    listeners.set(type, listener as Listener);
    // Only `remove` is ever called on the subscription.
    return { remove: () => listeners.delete(type) } as unknown as ReturnType<
      typeof Keyboard.addListener
    >;
  });
});

afterEach(() => jest.restoreAllMocks());

// RN's `height` stops at the top of the navigation bar and the edge-to-edge
// frame does not, so a lift of the bare height leaves the panel's last 24dp
// behind the keys.
it('lifts by the keyboard height plus the bottom inset the frame runs under', () => {
  const { result } = renderHook(() => useShareKeyboard(NAV_BAR));
  expect(result.current).toBe(0);

  emit('keyboardDidShow', SHOWN);

  expect(result.current).toBeCloseTo(SHOWN.height + NAV_BAR);
});

it('falls back to zero on a hide, whatever the hide payload says', () => {
  const { result } = renderHook(() => useShareKeyboard(NAV_BAR));
  emit('keyboardDidShow', SHOWN);

  emit('keyboardDidHide', HIDDEN);

  // Not the inset either: a hidden keyboard covers none of it.
  expect(result.current).toBe(0);
});

// The inset arrives a frame after the sheet mounts (share-kit.tsx seeds zero),
// and switching between gesture and 3-button navigation changes it under a
// mounted sheet.
it('follows an inset that changes while the keyboard is up', () => {
  const { result, rerender } = renderHook(({ inset }) => useShareKeyboard(inset), {
    initialProps: { inset: 0 },
  });
  emit('keyboardDidShow', SHOWN);

  rerender({ inset: 48 });

  expect(result.current).toBeCloseTo(SHOWN.height + 48);
});
