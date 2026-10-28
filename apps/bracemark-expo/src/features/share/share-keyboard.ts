// How far the share sheet has to lift itself, and why it cannot ask React
// Native (docs/share-sheet.md, _what an app-extension process breaks in React
// Native itself_).
//
// Inside the iOS share extension EVERY keyboard frame RN reports is zero:
// `RCTKeyboardObserver.mm` converts the notification's frame through
// `RCTKeyWindow()`, which returns nil in an app extension by contract, and a
// message to nil yields CGRectZero. So `Keyboard.metrics()`, every
// `keyboardWillShow` payload and `KeyboardAvoidingView` all say
// `screenY: 0, height: 0` — no error, no warning, a plausible-looking number.
// KAV's lift is `frame.y + frame.height - (screenY - keyboardVerticalOffset)`,
// which against `screenY: 0` is the panel's whole height (plus the offset), so
// its padding exceeds the surface it pads: the panel's content box collapses to
// nothing, the panel shrinks to its own paddings and `justify-end` parks it
// ABOVE the sheet. That is the render this replaces, and no amount of
// `keyboardVerticalOffset` fixes it — the offset makes it worse, and it feeds
// back into KAV's own onLayout.
//
// react-native-keyboard-controller cannot stand in either, for the reason
// docs/soft-keyboard.md already bans it here: its iOS layer locates the
// keyboard through `UIApplication.shared.windows` / `.activeWindow`, the very
// API an extension process does not have.
//
// So on iOS the number comes from our own native module — `BracemarkShareKeyboard`,
// modules/bracemark-share/ios — which reads `UIKeyboardFrameEndUserInfoKey`
// straight off the notification and measures it against the FRAME'S OWN UIView.
// It has to be measured natively, not summed in JS over screen coordinates: on an
// iPad the host floats the sheet as a form sheet and then moves it out of the
// keyboard's way on its own, and neither the card's position nor that move is
// visible to JS (docs/share-sheet.md, _on an iPad the sheet floats_).
//
// ⚠ AND THE FRAME IS A PLAIN VIEW, NOT A NATIVE ONE. It was an Expo native view
// that measured itself, and on an iPhone 12 that one view kept the share
// extension at the memory-warning line under its 120MB cap for as long as the
// sheet was up; a plain View that hands the module its tag (`track`, from
// `onLayout`) measures the same box for nothing (docs/share-sheet.md, _the
// share extension has almost no memory to spare_). `collapsable={false}` is
// what keeps that box real: Fabric flattens a style-only View out of the
// native tree, and then there is no UIView behind the tag to measure.
//
// Everything platform-shaped about this lives HERE, so share-kit.tsx stays one
// tree for both hosts.
//
// ANDROID IS IN THIS FILE TOO, and it no longer goes through RN's
// KeyboardAvoidingView either — for a different lie. Its share activity rides
// the app's own process, where RN's keyboard events are real, and KAV lifted
// the panel correctly on the way UP. On the way DOWN it did not come back:
// `ReactRootView` sends `keyboardDidHide` with `screenY` =
// `getWindowVisibleDisplayFrame().height()`, a LENGTH that leaves out the status
// and navigation bars, and KAV on Android feeds hide through the same
// `frame.y + frame.height - screenY` as show. Under edge-to-edge the frame spans
// the whole window, so the "hidden" keyboard still overlapped it by both bars
// — 840 against a 914dp window on the Pixel 8 AVD — and the panel stayed
// parked 74dp above the bottom edge with the keyboard gone, until the sheet was
// reopened. So the hook below reads the same events and trusts only what is
// true in them: the height on show, and the fact of a hide.

import { createElement, useCallback, useEffect, useRef, useState } from 'react';
import {
  findNodeHandle,
  Keyboard,
  LayoutAnimation,
  Platform,
  View,
  type ViewProps,
} from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

// The native payload, in the frame's own points (BracemarkShareKeyboardModule.swift).
// `overlap` is how much of the frame's bottom the keyboard covers — 0 while it
// is down, so the lift falls to zero without a special case; `detached` is
// whether the frame stops short of the window's bottom edge. `durationMs` is the
// keyboard's own animation and `startedAtMs` when it began, on `Date.now()`'s
// clock — both 0 for a measure no keyboard motion caused.
export type KeyboardGeometry = {
  overlap: number;
  detached: boolean;
  durationMs: number;
  startedAtMs: number;
};

// Below this much of the keyboard's motion left, the panel jumps rather than
// animates: one frame of travel reads as a jump anyway.
const MIN_TRAVEL_MS = 16;

type ShareKeyboardModule = {
  track: (viewTag: number) => void;
  addListener: (
    event: 'onKeyboardGeometry',
    listener: (geometry: KeyboardGeometry) => void,
  ) => { remove: () => void };
};

// OPTIONAL, not required, and that is the whole platform split: the module is
// iOS-only (expo-module.config.json registers no Android class for it), so it is
// null in Android's share activity — which rides the app's own process and reads
// RN's keyboard events instead (the hook below) — and null under jest. Resolved
// at module scope because `requireOptionalNativeModule` is a lookup in a
// registry that is already populated, not a require of anything heavy (the
// extension bundle's init budget is docs/share-sheet.md's, _keep index.share.js
// lean_).
const shareKeyboard = requireOptionalNativeModule<ShareKeyboardModule>('BracemarkShareKeyboard');

/**
 * The box the sheet's lift is measured against — share-kit.tsx's outermost
 * frame, filling the extension's root. A plain View on every host; on iOS it
 * also hands the native module its tag on every layout, so the module can
 * measure its overlap with the keyboard (the header).
 */
export function ShareKeyboardFrame({ onLayout, ...props }: ViewProps) {
  const ref = useRef<View>(null);
  const track = useCallback<NonNullable<ViewProps['onLayout']>>(
    (event) => {
      // A number or nothing: `findNodeHandle` answers null for a view that is not
      // mounted, and undefined under jest's renderer.
      const tag = shareKeyboard && ref.current ? findNodeHandle(ref.current) : null;
      if (typeof tag === 'number') shareKeyboard?.track(tag);
      onLayout?.(event);
    },
    [onLayout],
  );

  // `createElement` rather than JSX only because this file is `.ts`, and the docs
  // name it.
  return createElement(View, { ...props, ref, collapsable: false, onLayout: track });
}

/**
 * How the share frame makes room for the keyboard. ONE shape on both hosts:
 *
 *   - `lift` — how far the frame pads its own bottom so the panel comes to rest
 *     on the keyboard's top edge: how much of the frame the keyboard covers,
 *     zero while it is down. share-kit.tsx uses it twice: as the frame's
 *     bottom padding, and to cancel the bottom safe-area inset, because a
 *     keyboard's frame runs to the BOTTOM of the screen — it CONTAINS the home
 *     indicator / gesture bar rather than stopping above it
 *     (docs/safe-area.md).
 *   - `detached` — the host made the sheet a floating card rather than a
 *     bottom sheet (an iPad's form sheet), so the panel centres instead of
 *     sitting on an edge that is not the screen's.
 *
 * The hosts measure the lift differently:
 *
 *   - iOS — the frame's own `overlap`, from the native module's
 *     `onKeyboardGeometry` event: exact wherever the host puts the sheet,
 *     including after it has moved the sheet for the keyboard itself.
 *   - Android — the event's `height` plus `bottomInset`. RN reports that height
 *     as the IME inset MINUS the system bars' (`ReactRootView`), i.e. measured
 *     from the top of the navigation bar, while the edge-to-edge frame runs
 *     underneath that bar; adding the inset back gives the IME inset itself,
 *     which is the window's own account of how much of its bottom the keyboard
 *     covers. Not `screenHeight - screenY`: that holds only while the window is
 *     the screen, and on a hide `screenY` is not a position at all (the header).
 *     Never detached: the activity is the whole window.
 */
export function useShareKeyboard(bottomInset: number): { lift: number; detached: boolean } {
  // What the host last reported, in ITS terms: the overlap itself on iOS; on
  // Android the keyboard's height above the system bars. Null while the
  // keyboard is down rather than zero, because the Android inset is added at
  // render (so a changed inset is never stale in a listener) and a hidden
  // keyboard must not get one.
  const [reported, setReported] = useState<number | null>(null);
  const [detached, setDetached] = useState(false);

  useEffect(() => {
    // Gated on the platform as well as the lookup, so the branch is the host's
    // and not an accident of which modules a build happens to register.
    const native = Platform.OS === 'ios' ? shareKeyboard : null;
    if (native) {
      const subscription = native.addListener('onKeyboardGeometry', (geometry) => {
        // Riding along with the keyboard, which takes two corrections, both
        // seen on an iPhone 12 (docs/share-sheet.md, _what an app-extension
        // process breaks in React Native itself_). Nothing here touches
        // Reanimated: LayoutAnimation is a native
        // view-level animation, which is what the share bundle is allowed to
        // use (share-root.tsx).
        //
        //   - OVER WHAT IS LEFT of the keyboard's motion, not all of it. The
        //     keys start moving at the notification; this runs one main-queue
        //     turn, a crossing to JS and a React commit later. Given the whole
        //     duration from here, the panel started late AND finished late.
        //   - `easeOut`, NOT `keyboard`. Fabric's LayoutAnimation does not
        //     implement the `keyboard` type: it falls through to LINEAR
        //     (react/renderer/animations/utils.cpp), so the panel crept up at
        //     an even pace under keys that decelerate hard. `easeOut` is the
        //     nearest curve Fabric has — fast first, settling last.
        const remaining =
          geometry.startedAtMs > 0
            ? geometry.durationMs - (Date.now() - geometry.startedAtMs)
            : geometry.durationMs;
        if (remaining >= MIN_TRAVEL_MS) {
          LayoutAnimation.configureNext({
            duration: remaining,
            update: { duration: remaining, type: 'easeOut' },
          });
        }
        setReported(geometry.overlap > 0 ? geometry.overlap : null);
        setDetached(geometry.detached);
      });

      return () => subscription.remove();
    }

    // Not Android and no module — an iOS build where it failed to resolve, or
    // jest — HOLDS AT ZERO rather than falling through to RN's events below:
    // those are the very thing that lies in the iOS extension process, and a
    // zero lift leaves the safe-area inset switched on, which is the safe way to
    // be wrong.
    if (Platform.OS !== 'android') return;

    // `Did`, not `Will`: the Will events are iOS-only. The hide's payload is
    // ignored on purpose (the header).
    const shown = Keyboard.addListener('keyboardDidShow', (event) =>
      setReported(event.endCoordinates.height),
    );
    const hidden = Keyboard.addListener('keyboardDidHide', () => setReported(null));

    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  let lift = 0;
  if (reported !== null) {
    lift = Platform.OS === 'android' ? Math.max(reported + bottomInset, 0) : reported;
  }

  return { lift, detached };
}
