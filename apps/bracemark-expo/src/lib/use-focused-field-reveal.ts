import { type ComponentProps, useRef } from 'react';
import type { LayoutChangeEvent, NativeSyntheticEvent, TextInput, View } from 'react-native';
import { useKeyboardHandler } from 'react-native-keyboard-controller';
import Animated, {
  measure,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue,
} from 'react-native-reanimated';

// Keep the focused field above the fold in a form that SHRINKS for the
// keyboard — the body scroller of every ui/sheet.tsx sheet (the add panel, the
// link editor, Advanced Search). The sheet's avoider shrinks the scroller's
// viewport as the keyboard rises but keeps its offset, so a field focused low
// in the form (Note, a checklist's filter) sinks below the new fold, and
// nothing else tracks it: an aware scroller cannot nest inside an avoider
// (docs/soft-keyboard.md, _avoidance_).
//
// Each field reports its focus and blur; its bottom edge is taken in CONTENT
// coordinates (`measureLayout` against the content View — offset-independent,
// where a measured pageY lags a scrollTo), and the scroll goes to the absolute
// offset that puts that edge ON the viewport's bottom edge, only ever downward.
// On the edge and not 16 above it, because the 16 between a field and the
// keyboard is already there: the sheet's footer, pinned below the scroller,
// starts with `pt-4`. Driven off the keyboard's per-frame events gated on their
// `target`, plus a reaction for what the keyboard never announces — focus
// moving under a keyboard that is already up (animated), and the focused field
// GROWING as a multiline note is typed into (instant, as a native text view
// follows its caret), which the content View's layout reports.
//
// Three traps, all silent (docs/soft-keyboard.md, _the add panel_, has the
// specimens): `useReanimatedKeyboardAnimation().height` is written once on iOS,
// not per frame; a measured pageY inside a scroller lags a `scrollTo`; and a
// JS focus flag cleared in `onBlur` reaches the UI thread frames after the
// keyboard events of the field just tapped — hence the `target` gate.

// What a TextInput's `onFocus` hands over — Input and Textarea forward it as is.
export type FieldFocusHandler = NonNullable<ComponentProps<typeof TextInput>['onFocus']>;
type FocusEvent = Parameters<FieldFocusHandler>[0];
type FieldHost = FocusEvent['currentTarget'];

export function useFocusedFieldReveal() {
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  // The offset off the scroller's own events (`onScroll`, returned below), not
  // `useScrollOffset`: that hook checks its ref once, at mount — and the
  // opener calls this before its sheet's scroller exists (and, while the wide
  // editors were portaled Dialogs, a whole effect before), so it warned on
  // every open and might never have attached.
  const scrollOffset = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollOffset.set(e.contentOffset.y);
  });
  const content = useRef<View>(null);
  const focused = useRef<FieldHost | null>(null);
  const focusedTag = useSharedValue(-1);
  const focusedBottom = useSharedValue(-1);
  // Whether the next change of `focusedBottom` is focus moving (animate) or the
  // focused field growing (follow instantly).
  const animateNext = useSharedValue(false);

  const reveal = (animated: boolean) => {
    'worklet';
    const bottom = focusedBottom.get();
    if (bottom < 0) return;
    const viewport = measure(scrollRef);
    if (viewport === null) return;
    const target = bottom - viewport.height;
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
      if (now >= 0 && prev !== null && now !== prev) reveal(animateNext.get());
    },
  );

  const measureFocused = () => {
    const field = focused.current;
    const host = content.current;
    if (field === null || host === null) return;
    field.measureLayout(host, (_x, y, _width, height) => focusedBottom.set(y + height));
  };

  const onFieldFocus: FieldFocusHandler = (e: FocusEvent) => {
    focusedTag.set(e.nativeEvent.target);
    focused.current = e.currentTarget;
    animateNext.set(true);
    measureFocused();
  };
  // Forget the field once it loses focus, so a later relayout (a section
  // expanding, an image preview resolving) does not scroll back to a field
  // nobody is typing in.
  const onFieldBlur = (_e: NativeSyntheticEvent<unknown>) => {
    focused.current = null;
    focusedBottom.set(-1);
  };
  // The content re-laid out — the focused multiline field grew a line, or
  // something above it moved it. Re-measure; the reaction follows instantly.
  const onContentLayout = (_e: LayoutChangeEvent) => {
    animateNext.set(false);
    measureFocused();
  };

  return { scrollRef, onScroll, content, onFieldFocus, onFieldBlur, onContentLayout };
}

export type FocusedFieldReveal = ReturnType<typeof useFocusedFieldReveal>;
