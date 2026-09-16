// The Cancel/Save bar of a full-screen editor — edit link and Advanced Search,
// the two system-modal screens whose form scrolls under a bordered header. It is
// PINNED rather than the scroller's last child because both forms end past the
// fold on a phone: edit link's Save sat under the 12:7 image preview, a scroll
// away from the Note that "Edit note" lands on, and Search sat under the Tags
// tree. And it RIDES THE KEYBOARD, so a note can be typed and saved without
// putting the keyboard away first (docs/soft-keyboard.md, _the sticky footer_).
//
// The host renders this as the last child of its SafeAreaView column, after a
// `KeyboardAwareScrollView` whose `bottomOffset` adds the height reported by
// `onHeight` — the bar covers that band once it lifts, so a field focused
// behind it has to clear the bar and not just the keyboard. Nothing flags a
// missing offset: the field simply comes to rest under the bar.
//
// NOT keyboard-controller's `KeyboardStickyView`, which this was, and the reason
// is measured. That component moves itself through react-native's `Animated`
// (native driver), and an update to it did not reach a view inside a Modal that
// was still presenting: open Advanced Search with the basic search box focused
// and iOS hides the keyboard ~150ms into the sheet's slide — keyboard-controller
// reports the hide, height 0, and the value underneath is 0 — yet the bar stayed
// lifted a keyboard's height over an empty screen until the sheet next
// re-rendered. So the lift is a Reanimated shared value driven off the
// keyboard's own per-frame events, the mechanism link-add-panel.tsx already uses
// in the same tree.
//
// THE LIFT HANDS THE BOTTOM INSET BACK, on both platforms. The bar rests on the
// SafeAreaView's bottom padding, and the reported keyboard height runs to the
// bottom of the screen: on iOS the keyboard's frame contains the home indicator,
// and on Android keyboard-controller reports the IME inset INCLUDING the
// navigation bar, because edge-to-edge is on (`edgeToEdgeEnabled`, which makes
// the provider pass `navigationBarTranslucent`). Lifting by the full height
// would float the bar an inset's height above the keys.

import { type ReactNode } from 'react';
import { View } from 'react-native';
import { KeyboardController, useKeyboardHandler } from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function StickyFooter({
  onHeight,
  children,
}: {
  onHeight: (height: number) => void;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  // Seeded from the keyboard's last settled state: the handler below only hears
  // events from its own mount on, and a bar mounted over a keyboard that is
  // already up has to start on it rather than under it.
  const keyboardHeight = useSharedValue(
    KeyboardController.isVisible() ? KeyboardController.state().height : 0,
  );
  useKeyboardHandler(
    {
      onMove: (e) => {
        'worklet';
        keyboardHeight.set(e.height);
      },
      onInteractive: (e) => {
        'worklet';
        keyboardHeight.set(e.height);
      },
      onEnd: (e) => {
        'worklet';
        keyboardHeight.set(e.height);
      },
    },
    [],
  );
  // Clamped at 0, so the bar holds still while the keyboard's top edge is
  // still inside the inset band it already clears.
  const liftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(keyboardHeight.get() - insets.bottom, 0) }],
  }));

  return (
    <Animated.View style={liftStyle}>
      {/* The header's bar, mirrored: `border-t` for its `border-b` (content
          scrolls under both edges), `bg-background` so the rows it covers don't
          show through, and `py-2.5` around the `sm` buttons' 36 for the app's
          ordinary 56pt bar. Right-aligned, ghost Cancel then the filled action —
          the editors' footer row (docs/editors.md, _the editing surfaces_). */}
      <View
        onLayout={(e) => onHeight(e.nativeEvent.layout.height)}
        className="flex-row justify-end gap-2 border-t border-border bg-background px-4 py-2.5"
      >
        {children}
      </View>
    </Animated.View>
  );
}
