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
// So the number comes from our own module — `BracemarkShareKeyboard`,
// modules/bracemark-share/ios — which reads `UIKeyboardFrameEndUserInfoKey`
// straight off the notification (it is posted in screen coordinates and needs no
// window) and emits the keyboard's top edge. Everything platform-shaped about
// that lives HERE, so share-kit.tsx stays one tree for both hosts.
//
// ANDROID IS IN THIS FILE TOO, and it no longer goes through RN's
// KeyboardAvoidingView either — for a different lie. Its share activity rides
// the app's own process, where RN's keyboard events are real, and KAV lifted
// the panel correctly on the way UP. On the way DOWN it did not come back:
// `ReactRootView` sends `keyboardDidHide` with `screenY` =
// `getWindowVisibleDisplayFrame().height()`, a LENGTH that leaves out the status
// and navigation bars, and KAV on Android feeds hide through the same
// `frame.y + frame.height - screenY` as show. Under edge-to-edge the frame
// spans the whole window, so the "hidden" keyboard still overlapped it by both
// bars — 840 against a 914dp window on the Pixel 8 AVD — and the panel stayed
// parked 74dp above the bottom edge with the keyboard gone, until the sheet was
// reopened. So the hook below reads the same events and trusts only what is
// true in them: the height on show, and the fact of a hide.

import { useEffect, useState } from 'react';
import { Dimensions, Keyboard, LayoutAnimation, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

// The native payload. `screenY` is the keyboard's top edge in screen points —
// on a hide, the bottom of the screen, so the lift below falls to zero without a
// special case.
type KeyboardFrameEvent = { screenY: number; height: number; durationMs: number };

type ShareKeyboardModule = {
  addListener: (
    event: 'keyboardFrameChange',
    listener: (payload: KeyboardFrameEvent) => void,
  ) => { remove: () => void };
};

// OPTIONAL, not required, and that is the whole platform split: the module is
// iOS-only, so this is null in Android's share activity — which rides the app's
// own process and reads RN's keyboard events instead (the hook below) — and
// null under jest, where the hook then reports a keyboard that is never up. Resolved at module scope because
// `requireOptionalNativeModule` is a lookup in a registry that is already
// populated, not a require of anything heavy (the extension bundle's init
// budget is docs/share-sheet.md's, _keep index.share.js lean_).
const shareKeyboard =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<ShareKeyboardModule>('BracemarkShareKeyboard')
    : null;

/**
 * How far the share frame pads its own bottom so the panel comes to rest on the
 * keyboard's top edge — how much of the frame the keyboard covers, zero while
 * it is down. ONE number on both hosts, and share-kit.tsx uses it twice: as
 * the frame's bottom padding, and to cancel the bottom safe-area inset, because
 * a keyboard's frame runs to the BOTTOM of the screen — it CONTAINS the home
 * indicator / gesture bar rather than stopping above it (docs/safe-area.md).
 *
 * The hosts measure it differently:
 *
 *   - iOS — `panelBottom` minus the keyboard's top edge, from our own module.
 *     `panelBottom` is where the sheet's own bottom edge sits on the screen.
 *     The extension's RN root is placed by expo-share-extension at
 *     `screenHeight - ShareExtensionHeight`, i.e. flush with the bottom of the
 *     screen, so the default is the screen's own bottom; passing it explicitly
 *     keeps the arithmetic honest if that ever stops being true, rather than
 *     silently lifting by a keyboard height that no longer applies.
 *   - Android — the event's `height` plus `bottomInset`. RN reports that height
 *     as the IME inset MINUS the system bars' (`ReactRootView`), i.e. measured
 *     from the top of the navigation bar, while the edge-to-edge frame runs
 *     underneath that bar; adding the inset back gives the IME inset itself,
 *     which is the window's own account of how much of its bottom the keyboard
 *     covers. Not `screenHeight - screenY`: that holds only while the window is
 *     the screen, and on a hide `screenY` is not a position at all (the header).
 */
export function useShareKeyboard(
  bottomInset: number,
  panelBottom = Dimensions.get('screen').height,
): number {
  // What the host last reported, in ITS terms: the lift itself on iOS; on
  // Android the keyboard's height above the system bars, or null while it is
  // down. Null and not zero, because the inset is added at render (so a changed
  // inset is never stale in a listener) and a hidden keyboard must not get one.
  const [reported, setReported] = useState<number | null>(null);

  useEffect(() => {
    if (shareKeyboard) {
      const subscription = shareKeyboard.addListener('keyboardFrameChange', (event) => {
        // On the system's own curve and duration — the same thing RN's
        // KeyboardAvoidingView does with the same numbers, so the panel travels
        // with the keyboard instead of snapping a frame ahead of it. Nothing here
        // touches Reanimated: LayoutAnimation is a native view-level animation,
        // which is what the share bundle is allowed to use (share-root.tsx).
        if (event.durationMs > 0) {
          LayoutAnimation.configureNext({
            duration: event.durationMs,
            update: { duration: event.durationMs, type: 'keyboard' },
          });
        }
        setReported(Math.max(panelBottom - event.screenY, 0));
      });

      return () => subscription.remove();
    }

    // Not Android and no module — an iOS build where it failed to resolve, or
    // jest. HOLD AT ZERO rather than falling through to RN's events below:
    // those are the very thing that lies in this process, and a zero lift
    // leaves the safe-area inset switched on, which is the safe way to be
    // wrong.
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
  }, [panelBottom]);

  if (reported === null) return 0;
  return shareKeyboard ? reported : Math.max(reported + bottomInset, 0);
}
