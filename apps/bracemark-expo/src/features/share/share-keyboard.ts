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

import { useEffect, useState } from 'react';
import { Dimensions, LayoutAnimation, Platform } from 'react-native';
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
 * The points of the sheet the keyboard currently covers — what the iOS frame
 * pads its bottom with, and 0 on every other host.
 *
 * `panelBottom` is where the sheet's own bottom edge sits on the screen. The
 * extension's RN root is placed by expo-share-extension at
 * `screenHeight - ShareExtensionHeight`, i.e. flush with the bottom of the
 * screen, so the default is the screen's own bottom; passing it explicitly
 * keeps the arithmetic honest if that ever stops being true, rather than
 * silently lifting by a keyboard height that no longer applies.
 */
export function useShareKeyboardLift(panelBottom = Dimensions.get('screen').height): number {
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null);

  useEffect(() => {
    if (!shareKeyboard) return;

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
      setKeyboardTop(event.screenY);
    });

    return () => subscription.remove();
  }, []);

  if (keyboardTop === null) return 0;
  return Math.max(panelBottom - keyboardTop, 0);
}
