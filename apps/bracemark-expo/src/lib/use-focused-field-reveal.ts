import { type ComponentProps, useRef } from 'react';
import type { TextInput, View } from 'react-native';
import { useKeyboardHandler } from 'react-native-keyboard-controller';
import Animated, {
  measure,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue,
} from 'react-native-reanimated';

// Keep the focused field above the fold in a CARD that shrinks for the keyboard
// — the wide shells of Advanced Search (features/links/search-bar.tsx) and the
// link editor (features/links/link-edit-screen.tsx), both the kit's Dialog. It
// is the add panel's Note reveal (link-add-panel.tsx; docs/soft-keyboard.md, _the add
// panel_, carries its three traps), generalised from one field to all of them.
// The card's avoider shrinks this scroller's viewport as the keyboard rises but
// keeps its offset, so a field focused low in the form (Note, a checklist's
// filter) sinks below the new fold, and nothing else tracks it: an aware
// scroller cannot nest inside the kit's avoider. Each field reports its focus;
// its bottom edge is taken in CONTENT coordinates (`measureLayout` against the
// content View — offset-independent, where a measured pageY lags a scrollTo),
// and the scroll goes to the absolute offset that puts that edge 16 above the
// viewport's (the app's field-to-keyboard number), only ever downward. Driven
// off the keyboard's per-frame events gated on their `target`, plus a reaction
// for focus moving under a keyboard that is already up.
// What a TextInput's `onFocus` hands over — Input and Textarea forward it as is.
export type FieldFocusHandler = NonNullable<ComponentProps<typeof TextInput>['onFocus']>;

export function useFocusedFieldReveal() {
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  // The offset off the scroller's own events (`onScroll`, returned below), not
  // `useScrollOffset`: that hook checks its ref once, at mount, and both callers
  // mount before their scroller does — Advanced Search calls this while its
  // narrow shell is showing, and a Dialog's content portals in an effect later —
  // so it warned on every open and might never have attached.
  const scrollOffset = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollOffset.set(e.contentOffset.y);
  });
  const content = useRef<View>(null);
  const focusedTag = useSharedValue(-1);
  const focusedBottom = useSharedValue(-1);

  const reveal = (animated: boolean) => {
    'worklet';
    const bottom = focusedBottom.get();
    if (bottom < 0) return;
    const viewport = measure(scrollRef);
    if (viewport === null) return;
    const target = bottom + 16 - viewport.height;
    if (target > scrollOffset.get()) scrollTo(scrollRef, 0, target, animated);
  };
  useKeyboardHandler(
    {
      onMove: (e) => {
        'worklet';
        if (e.target === focusedTag.get()) reveal(false);
      },
      onEnd: (e) => {
        'worklet';
        if (e.target !== focusedTag.get()) return;
        requestAnimationFrame(() => {
          'worklet';
          reveal(false);
        });
      },
    },
    [],
  );
  useAnimatedReaction(
    () => focusedBottom.get(),
    (now, prev) => {
      if (now >= 0 && prev !== null && now !== prev) reveal(true);
    },
  );

  const onFieldFocus: FieldFocusHandler = (e) => {
    focusedTag.set(e.nativeEvent.target);
    const host = content.current;
    if (host === null) return;
    e.currentTarget.measureLayout(host, (_x, y, _width, height) => focusedBottom.set(y + height));
  };

  return { scrollRef, onScroll, content, onFieldFocus };
}
