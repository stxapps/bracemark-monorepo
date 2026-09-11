import { Platform, Pressable } from 'react-native';
import Animated from 'react-native-reanimated';

// react-native-reusables `native-only-animated-view` (uniwind variant), copied
// from the registry — see docs/setup.md for why the copy is manual (the CLI
// needs tsconfig path aliases; this app uses relative imports). Local changes
// vs upstream: the two spreads cast to the target component's props (minus the
// JSX-reserved `key`, which AnimatedProps wraps in a SharedValue union) — under
// this workspace's stricter TS the union parameter type doesn't narrow on the
// optional `as`, so each branch's incompatible `ref`/`key` shapes fail
// typecheck when spread raw (runtime behavior unchanged; upstream also spreads
// the whole props object, stray `as` included). Plus POPUP_FADE_MS below.

// How long a portaled surface — dialog, alert dialog, dropdown menu — takes to
// fade in or out on native, and it is web-ui's `duration-100`: each of those
// three sets it on its overlay and its content alike, so tw-animate-css's own
// 150ms default never applies there. One number for the three, so the kits
// cannot drift apart surface by surface — which is how they did: a builder given
// no `.duration()` runs Reanimated's default 300, so the menu took three times
// web's time and the dialog's content, with the registry's 50ms delay on top,
// three and a half. Only the duration ports: web's `zoom-in-95` (and the menu's
// `slide-in-from-top-2`) have no counterpart here, and the curve is
// Reanimated's default rather than CSS `ease`.
const POPUP_FADE_MS = 100;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * This component is used to wrap animated views that should only be animated on native.
 * @param props - The props for the animated view.
 * @returns The animated view if the platform is native, otherwise the children.
 * @example
 * <NativeOnlyAnimatedView entering={FadeIn} exiting={FadeOut}>
 *   <Text>I am only animated on native</Text>
 * </NativeOnlyAnimatedView>
 */
function NativeOnlyAnimatedView(
  props:
    | (React.ComponentProps<typeof Animated.View> &
        React.RefAttributes<typeof Animated.View> & { as?: 'View' })
    | (React.ComponentProps<typeof AnimatedPressable> &
        React.RefAttributes<typeof AnimatedPressable> & { as: 'Pressable' }),
) {
  if (Platform.OS === 'web') {
    return props.children as React.ReactNode;
  } else {
    if (props.as === 'Pressable') {
      return (
        <AnimatedPressable
          {...(props as Omit<React.ComponentProps<typeof AnimatedPressable>, 'key'>)}
        />
      );
    }
    return <Animated.View {...(props as React.ComponentProps<typeof Animated.View>)} />;
  }
}

export { NativeOnlyAnimatedView, POPUP_FADE_MS };
