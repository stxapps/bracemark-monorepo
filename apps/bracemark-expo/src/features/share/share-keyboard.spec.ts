// The Android half of the share sheet's lift (share-keyboard.ts). The failure
// it replaces was silent and one-directional: RN's KeyboardAvoidingView lifted
// the sheet correctly and then left it 74dp above the bottom of the screen once
// the keyboard closed, because `keyboardDidHide` carries a `screenY` that is
// not a position. The payloads below are the ones the Pixel 8 AVD sent.
//
// The iOS half is measured natively (BracemarkShareKeyboardModule.swift) — what
// is wrong with RN's own numbers in that process, and where an iPad's host puts
// the sheet, cannot be reproduced under jest. What CAN be pinned is the hook's
// side of the contract: the native module's event in, the frame's lift and
// shape out; and the frame's side: its tag out, on every layout.

import { createElement } from 'react';
import { Keyboard, type KeyboardEvent, LayoutAnimation, Platform } from 'react-native';
import { act, fireEvent, render, renderHook } from '@testing-library/react-native';

import { type KeyboardGeometry, ShareKeyboardFrame, useShareKeyboard } from './share-keyboard';

// The native module, faked once for the file: it is resolved at import, and the
// hook picks its branch by `Platform.OS` at run time (Android never reaches it).
const mockNative = {
  geometry: undefined as ((geometry: KeyboardGeometry) => void) | undefined,
  track: jest.fn(),
};
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  requireOptionalNativeModule: (name: string) =>
    name === 'BracemarkShareKeyboard'
      ? {
          // Looked up per call: the factory runs before `mockNative` is assigned.
          track: (tag: number) => mockNative.track(tag),
          addListener: (_event: string, listener: (geometry: KeyboardGeometry) => void) => {
            mockNative.geometry = listener;
            return { remove: () => (mockNative.geometry = undefined) };
          },
        }
      : null,
}));

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

  function emitGeometry(overlap: number, detached: boolean, durationMs = 0, startedAtMs = 0) {
    act(() => mockNative.geometry?.({ overlap, detached, durationMs, startedAtMs }));
  }

  // The landscape iPad specimen: a 640pt form sheet the host has moved to y 52,
  // under a keyboard whose top edge is at 398 — the frame's own overlap, NOT
  // the keyboard's 422pt height, which is what lifted the panel off the keys.
  it("lifts by the frame's own overlap, not the keyboard's height, and ignores the inset", () => {
    const { result } = renderHook(() => useShareKeyboard(34));

    emitGeometry(294, true);

    expect(result.current.lift).toBe(294);
    expect(result.current.detached).toBe(true);
  });

  it('falls to zero when the keyboard no longer covers the frame', () => {
    const { result } = renderHook(() => useShareKeyboard(34));
    emitGeometry(294, true);

    emitGeometry(0, true);

    expect(result.current.lift).toBe(0);
    expect(result.current.detached).toBe(true);
  });

  it("rides the keyboard's own duration, and only when there is one", () => {
    const configureNext = jest.spyOn(LayoutAnimation, 'configureNext').mockImplementation();
    renderHook(() => useShareKeyboard(0));

    emitGeometry(0, false);
    expect(configureNext).not.toHaveBeenCalled();

    emitGeometry(300, false, 250);
    expect(configureNext).toHaveBeenCalledWith(expect.objectContaining({ duration: 250 }));
  });

  // The event lands a main-queue turn, a JS crossing and a commit after the
  // keys started moving; the whole duration from there finished late.
  it('animates over what is left of the keyboard motion, on a curve Fabric implements', () => {
    const configureNext = jest.spyOn(LayoutAnimation, 'configureNext').mockImplementation();
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    renderHook(() => useShareKeyboard(0));

    emitGeometry(300, false, 250, 10_000 - 90);

    expect(configureNext).toHaveBeenCalledWith({
      duration: 160,
      // Not `keyboard`: Fabric has no such curve and runs it linear.
      update: { duration: 160, type: 'easeOut' },
    });
  });

  it('jumps instead of animating once the keyboard has finished moving', () => {
    const configureNext = jest.spyOn(LayoutAnimation, 'configureNext').mockImplementation();
    jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const { result } = renderHook(() => useShareKeyboard(0));

    emitGeometry(300, false, 250, 10_000 - 400);

    expect(configureNext).not.toHaveBeenCalled();
    expect(result.current.lift).toBe(300);
  });

  // RN's own keyboard events are zeroed in the extension process; listening
  // to them is what collapsed the sheet in the first place.
  it("never listens to RN's keyboard events", () => {
    renderHook(() => useShareKeyboard(0));

    expect(Keyboard.addListener).not.toHaveBeenCalled();
  });

  it('stops listening when the frame unmounts', () => {
    const { unmount } = renderHook(() => useShareKeyboard(0));
    expect(mockNative.geometry).toBeDefined();

    unmount();

    expect(mockNative.geometry).toBeUndefined();
  });

  // The module measures the UIView behind the frame's tag, so the frame has to
  // stay a real native view: a style-only View is flattened out of Fabric's tree
  // and leaves the tag nothing to resolve to (share-keyboard.ts, the header).
  // jest's renderer has no native tags, so what is pinned here is the frame's
  // shape and that it never hands the module anything but a number; the tag
  // itself is only real on a device.
  it('is never flattened, forwards its layouts, and sends the module only real tags', () => {
    mockNative.track.mockClear();
    const onLayout = jest.fn();
    const screen = render(createElement(ShareKeyboardFrame, { testID: 'frame', onLayout }));
    const frame = screen.getByTestId('frame');
    const layout = { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } };

    fireEvent(frame, 'layout', layout);
    fireEvent(frame, 'layout', layout);

    expect(frame.props.collapsable).toBe(false);
    expect(onLayout).toHaveBeenCalledTimes(2);
    for (const [tag] of mockNative.track.mock.calls) expect(typeof tag).toBe('number');
  });
});
