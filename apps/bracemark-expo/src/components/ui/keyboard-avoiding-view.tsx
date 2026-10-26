import { type ComponentProps, useLayoutEffect } from 'react';
import { type LayoutChangeEvent, type LayoutRectangle, type ViewProps } from 'react-native';
import {
  useKeyboardHandler,
  useReanimatedKeyboardAnimation,
  useWindowDimensions,
} from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';

// keyboard-controller's `KeyboardAvoidingView`, `behavior="padding"` only, with
// ONE change: the overlap it pads by is capped at the keyboard's own height.
// ui/sheet.tsx and ui/dialog.tsx are the callers, and the reasons they want
// this library's avoider rather than react-native's are theirs; this file is
// only about why it is a copy.
//
// The library lifts by `max(frame.y + frame.height − (screenHeight −
// keyboardHeight − offset), 0)` (pinned 1.18.5, and unchanged through 1.22.8),
// where `frame` is the avoider's own `onLayout`, written on the UI runtime, and
// `screenHeight` is its `windowDidResize` event, which reaches the style through
// a React render. A ROTATION changes both, on two clocks, and nothing orders
// them. When the new height wins, the style pairs the landscape window with
// the PORTRAIT frame: on the tablet AVD (1280×800dp, a 376dp keyboard) that is
// 1280 − (800 − 376) = 856dp of padding in an 800dp window. Everything inside is
// squeezed to zero for a frame, and Android (P+) clears focus from a view laid
// out at zero size — `View.sizeChange`, caught by a breakpoint on the URL
// field's `onFocusChanged` under a Fabric `updateLayout`. So a turn to
// landscape with the add panel's keyboard up blurred the field and dropped the
// keyboard, intermittently, as the race fell (WINDOW-ROTATE-ANDROID-001). The
// turn the other way is harmless: there the stale frame is the SHORTER one,
// the overlap goes negative and the `max` floors it.
//
// No box can be overlapped by more than the keyboard is tall, so the cap only
// bites while the two inputs disagree, and then it pads by the right number.
// Everything else is the library's: the lift scales with the keyboard's
// per-frame `progress`, and `heightWhenOpened` is the height at the last open,
// so a closing keyboard keeps its scale.
export function KeyboardAvoidingView({
  behavior: _behavior,
  enabled = true,
  keyboardVerticalOffset = 0,
  style,
  onLayout,
  ...props
}: Omit<ComponentProps<typeof Animated.View>, 'onLayout'> & {
  /** The one behaviour kept — named at the call site, where comments rely on it. */
  behavior: 'padding';
  onLayout?: ViewProps['onLayout'];
  /** Off, it is a plain view (ui/dialog.tsx's web branch). */
  enabled?: boolean;
  /** Added to the keyboard's height — ui/dialog.tsx's bottom gutter. */
  keyboardVerticalOffset?: number;
}) {
  const { height: screenHeight } = useWindowDimensions();
  const keyboard = useReanimatedKeyboardAnimation();
  const frame = useSharedValue<LayoutRectangle | null>(null);
  const progress = useSharedValue(0);
  const heightWhenOpened = useSharedValue(0);

  // Mounted under a keyboard that is already up (a dialog opened from a focused
  // field): start from where it is, as the library does.
  useLayoutEffect(() => {
    heightWhenOpened.set(-keyboard.height.get());
    progress.set(keyboard.progress.get());
    // Once, at mount; the handler below follows from here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useKeyboardHandler(
    {
      onStart: (e) => {
        'worklet';
        if (e.height > 0) heightWhenOpened.set(e.height);
      },
      onMove: (e) => {
        'worklet';
        progress.set(e.progress);
      },
      onInteractive: (e) => {
        'worklet';
        progress.set(e.progress);
      },
      onEnd: (e) => {
        'worklet';
        progress.set(e.progress);
      },
    },
    [],
  );

  const animatedStyle = useAnimatedStyle(() => {
    if (!enabled) return {};
    const box = frame.get();
    if (box === null) return { paddingBottom: 0 };
    const lift = heightWhenOpened.get() + keyboardVerticalOffset;
    const overlap = box.y + box.height - (screenHeight - lift);
    return { paddingBottom: progress.get() * Math.min(Math.max(overlap, 0), lift) };
  });

  return (
    <Animated.View
      {...props}
      style={[style, animatedStyle]}
      onLayout={(e: LayoutChangeEvent) => {
        frame.set(e.nativeEvent.layout);
        onLayout?.(e);
      }}
    />
  );
}
