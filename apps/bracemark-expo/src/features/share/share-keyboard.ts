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
// ANDROID IS IN THIS FILE TOO, and only for the second of the two numbers
// below. Its share activity rides the app's own process, where RN's keyboard
// events are real and share-kit.tsx's KeyboardAvoidingView already does the
// lifting — so `lift` is zero there, as it always was. What BOTH hosts need is
// `cover`: how much of the screen's bottom edge the keyboard hides, which is
// what cancels the bottom safe-area inset while it is up (the hook's doc
// comment below; docs/safe-area.md). Reading that from RN on Android keeps the
// platform seam in this file rather than putting a `Platform.OS` back into
// share-kit.tsx.

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
// own process, where RN's keyboard events are correct and share-kit's
// KeyboardAvoidingView does the work — and null under jest, where the hook then
// reports a keyboard that is never up. Resolved at module scope because
// `requireOptionalNativeModule` is a lookup in a registry that is already
// populated, not a require of anything heavy (the extension bundle's init
// budget is docs/share-sheet.md's, _keep index.share.js lean_).
const shareKeyboard =
  Platform.OS === 'ios'
    ? requireOptionalNativeModule<ShareKeyboardModule>('BracemarkShareKeyboard')
    : null;

/**
 * What the share frame needs to know about the keyboard, as TWO numbers,
 * because the two hosts need different things from it:
 *
 *   - `lift` is LAYOUT — the points the iOS frame pads its own bottom with, so
 *     the panel comes to rest on the keyboard's top edge. It is ZERO ON
 *     ANDROID, where share-kit.tsx's KeyboardAvoidingView applies the same
 *     quantity itself; pad by this there as well and the panel lifts twice.
 *   - `cover` is a MEASUREMENT, on BOTH hosts — how much of the screen's bottom
 *     edge the keyboard hides. It exists to cancel the bottom safe-area inset,
 *     because a keyboard's frame runs to the BOTTOM of the screen: it CONTAINS
 *     the home indicator / gesture bar rather than stopping above it, so once
 *     the panel is parked on that frame, padding for the inset as well is dead
 *     space (share-kit.tsx's panel; docs/safe-area.md). NEVER pad by it.
 *
 * On iOS the two are the same number by construction. On Android `cover` comes
 * from RN's own keyboard events — the same payload KAV already pads by, so if
 * this reading were wrong the Android lift would be wrong with it — and it is
 * only ever compared against a ~24-48pt navigation-bar inset, never used as a
 * length, so the precision question does not arise there.
 *
 * `panelBottom` is where the sheet's own bottom edge sits on the screen. The
 * extension's RN root is placed by expo-share-extension at
 * `screenHeight - ShareExtensionHeight`, i.e. flush with the bottom of the
 * screen, so the default is the screen's own bottom; passing it explicitly
 * keeps the arithmetic honest if that ever stops being true, rather than
 * silently lifting by a keyboard height that no longer applies.
 */
export function useShareKeyboard(panelBottom = Dimensions.get('screen').height): {
  lift: number;
  cover: number;
} {
  const [cover, setCover] = useState(0);

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
        setCover(Math.max(panelBottom - event.screenY, 0));
      });

      return () => subscription.remove();
    }

    // Not Android and no module — an iOS build where it failed to resolve, or
    // jest. HOLD AT ZERO rather than falling through to RN's events below:
    // those are the very thing that lies in this process, and a zero `cover`
    // leaves the safe-area inset switched on, which is the safe way to be
    // wrong.
    if (Platform.OS !== 'android') return;

    // `Did`, not `Will`: the Will events are iOS-only.
    const shown = Keyboard.addListener('keyboardDidShow', (event) =>
      setCover(event.endCoordinates.height),
    );
    const hidden = Keyboard.addListener('keyboardDidHide', () => setCover(0));

    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [panelBottom]);

  return { lift: shareKeyboard ? cover : 0, cover };
}
