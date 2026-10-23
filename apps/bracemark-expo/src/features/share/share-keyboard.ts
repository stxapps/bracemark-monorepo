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
// So on iOS the number comes from our own native VIEW — `BracemarkShareKeyboard`,
// modules/bracemark-share/ios — which reads `UIKeyboardFrameEndUserInfoKey`
// straight off the notification and measures it against ITSELF. It has to be a
// view, not a JS sum over screen coordinates: on an iPad the host floats the
// sheet as a form sheet and then moves it out of the keyboard's way on its own,
// and neither the card's position nor that move is visible to JS
// (docs/share-sheet.md, _on an iPad the sheet floats_). Everything
// platform-shaped about this lives HERE, so share-kit.tsx stays one tree for
// both hosts.
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

import { type ComponentType, useCallback, useEffect, useState } from 'react';
import {
  Keyboard,
  LayoutAnimation,
  type NativeSyntheticEvent,
  Platform,
  View,
  type ViewProps,
} from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

// The native payload, in the view's own points (BracemarkShareKeyboardModule.swift).
// `overlap` is how much of the frame's bottom the keyboard covers — 0 while it
// is down, so the lift falls to zero without a special case; `detached` is
// whether the frame stops short of the window's bottom edge.
type KeyboardGeometry = { overlap: number; detached: boolean; durationMs: number };

export type KeyboardGeometryEvent = NativeSyntheticEvent<KeyboardGeometry>;

type ShareKeyboardFrameProps = ViewProps & {
  onKeyboardGeometry?: (event: KeyboardGeometryEvent) => void;
};

// OPTIONAL, not required, and that is the whole platform split: the module is
// iOS-only, so it is absent from Android's share activity — which rides the
// app's own process and reads RN's keyboard events instead (the hook below) —
// and from jest, where the frame is then a plain View that reports a keyboard
// that is never up. Resolved at module scope because
// `requireOptionalNativeModule` is a lookup in a registry that is already
// populated, not a require of anything heavy (the extension bundle's init
// budget is docs/share-sheet.md's, _keep index.share.js lean_).
const hasNativeFrame =
  Platform.OS === 'ios' && requireOptionalNativeModule('BracemarkShareKeyboard') !== null;

/**
 * The box the sheet's lift is measured against — share-kit.tsx's outermost
 * frame, filling the extension's root. On iOS the native view that measures
 * its own overlap with the keyboard; everywhere else a plain View, which drops
 * `onKeyboardGeometry` on the floor (Android's lift comes from RN's events).
 */
export const ShareKeyboardFrame: ComponentType<ShareKeyboardFrameProps> = hasNativeFrame
  ? requireNativeViewManager<ShareKeyboardFrameProps>('BracemarkShareKeyboard')
  : (View as ComponentType<ShareKeyboardFrameProps>);

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
 *   - `onKeyboardGeometry` — for `ShareKeyboardFrame`, the box it measures.
 *
 * The hosts measure the lift differently:
 *
 *   - iOS — the frame's own `overlap`, from the native view: exact wherever the
 *     host puts the sheet, including after it has moved the sheet for the
 *     keyboard itself.
 *   - Android — the event's `height` plus `bottomInset`. RN reports that height
 *     as the IME inset MINUS the system bars' (`ReactRootView`), i.e. measured
 *     from the top of the navigation bar, while the edge-to-edge frame runs
 *     underneath that bar; adding the inset back gives the IME inset itself,
 *     which is the window's own account of how much of its bottom the keyboard
 *     covers. Not `screenHeight - screenY`: that holds only while the window is
 *     the screen, and on a hide `screenY` is not a position at all (the header).
 *     Never detached: the activity is the whole window.
 */
export function useShareKeyboard(bottomInset: number): {
  lift: number;
  detached: boolean;
  onKeyboardGeometry: (event: KeyboardGeometryEvent) => void;
} {
  // What the host last reported, in ITS terms: the overlap itself on iOS; on
  // Android the keyboard's height above the system bars. Null while the
  // keyboard is down rather than zero, because the Android inset is added at
  // render (so a changed inset is never stale in a listener) and a hidden
  // keyboard must not get one.
  const [reported, setReported] = useState<number | null>(null);
  const [detached, setDetached] = useState(false);

  const onKeyboardGeometry = useCallback(({ nativeEvent }: KeyboardGeometryEvent) => {
    // On the system's own curve and duration — the same thing RN's
    // KeyboardAvoidingView does with the same numbers, so the panel travels
    // with the keyboard instead of snapping a frame ahead of it. Nothing here
    // touches Reanimated: LayoutAnimation is a native view-level animation,
    // which is what the share bundle is allowed to use (share-root.tsx).
    if (nativeEvent.durationMs > 0) {
      LayoutAnimation.configureNext({
        duration: nativeEvent.durationMs,
        update: { duration: nativeEvent.durationMs, type: 'keyboard' },
      });
    }
    setReported(nativeEvent.overlap > 0 ? nativeEvent.overlap : null);
    setDetached(nativeEvent.detached);
  }, []);

  useEffect(() => {
    // Not Android: the iOS lift arrives through `onKeyboardGeometry`. An iOS
    // build without the native view, or jest, HOLDS AT ZERO rather than falling
    // through to RN's events below: those are the very thing that lies in this
    // process, and a zero lift leaves the safe-area inset switched on, which is
    // the safe way to be wrong.
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

  return { lift, detached, onKeyboardGeometry };
}
