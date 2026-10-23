// The Android half of the share sheet's lift (share-keyboard.ts). The failure
// it replaces was silent and one-directional: RN's KeyboardAvoidingView lifted
// the sheet correctly and then left it 74dp above the bottom of the screen once
// the keyboard closed, because `keyboardDidHide` carries a `screenY` that is
// not a position. The payloads below are the ones the Pixel 8 AVD sent.
//
// The iOS half is measured natively (BracemarkShareKeyboardModule.swift) — what
// is wrong with RN's own numbers in that process, and where an iPad's host puts
// the sheet, cannot be reproduced under jest. What CAN be pinned is the hook's
// side of the contract: the native view's payload in, the frame's lift and
// shape out.

import { Keyboard, type KeyboardEvent, LayoutAnimation, Platform } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';

import { type KeyboardGeometryEvent, useShareKeyboard } from './share-keyboard';

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
  expect(result.current.lift).toBe(0);

  emit('keyboardDidShow', SHOWN);

  expect(result.current.lift).toBeCloseTo(SHOWN.height + NAV_BAR);
});

it('falls back to zero on a hide, whatever the hide payload says', () => {
  const { result } = renderHook(() => useShareKeyboard(NAV_BAR));
  emit('keyboardDidShow', SHOWN);

  emit('keyboardDidHide', HIDDEN);

  // Not the inset either: a hidden keyboard covers none of it.
  expect(result.current.lift).toBe(0);
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

  expect(result.current.lift).toBeCloseTo(SHOWN.height + 48);
});

describe('iOS', () => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'ios'));

  function geometry(overlap: number, detached: boolean, durationMs = 0) {
    return { nativeEvent: { overlap, detached, durationMs } } as KeyboardGeometryEvent;
  }

  // The landscape iPad specimen: a 640pt form sheet the host has moved to y 52,
  // under a keyboard whose top edge is at 398 — the frame's own overlap, NOT
  // the keyboard's 422pt height, which is what lifted the panel off the keys.
  it("lifts by the frame's own overlap, not the keyboard's height, and ignores the inset", () => {
    const { result } = renderHook(() => useShareKeyboard(34));

    act(() => result.current.onKeyboardGeometry(geometry(294, true)));

    expect(result.current.lift).toBe(294);
    expect(result.current.detached).toBe(true);
  });

  it('falls to zero when the keyboard no longer covers the frame', () => {
    const { result } = renderHook(() => useShareKeyboard(34));
    act(() => result.current.onKeyboardGeometry(geometry(294, true)));

    act(() => result.current.onKeyboardGeometry(geometry(0, true)));

    expect(result.current.lift).toBe(0);
    expect(result.current.detached).toBe(true);
  });

  it("rides the keyboard's own duration, and only when there is one", () => {
    const configureNext = jest.spyOn(LayoutAnimation, 'configureNext').mockImplementation();
    const { result } = renderHook(() => useShareKeyboard(0));

    act(() => result.current.onKeyboardGeometry(geometry(0, false)));
    expect(configureNext).not.toHaveBeenCalled();

    act(() => result.current.onKeyboardGeometry(geometry(300, false, 250)));
    expect(configureNext).toHaveBeenCalledWith(expect.objectContaining({ duration: 250 }));
  });

  // RN's own keyboard events are zeroed in the extension process; listening
  // to them is what collapsed the sheet in the first place.
  it("never listens to RN's keyboard events", () => {
    renderHook(() => useShareKeyboard(0));

    expect(Keyboard.addListener).not.toHaveBeenCalled();
  });
});
