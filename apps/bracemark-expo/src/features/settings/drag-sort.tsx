// Touch drag-to-reorder for the settings tables — the native counterpart of the
// dnd-kit layer bracemark-web's Lists/Tags sections use. Both expo sections share
// this one hook: the Tags table drags on the vertical axis only, the Lists table
// adds the horizontal axis (indent = parent) on top of it.
//
// THE SPLIT THAT MAKES THIS CHEAP: worklets own what's CONTINUOUS, JS owns what's
// DISCRETE. The finger tracking, the lifted row's transform, and every other
// row's ±rowHeight shift run on the UI thread at 60fps with zero re-renders. But
// the two things a drag actually MEANS — which slot it would land in, and at what
// depth — are discrete and change a handful of times per drag, so an
// `useAnimatedReaction` hands them back to JS and the section recomputes the
// shared projection (@stxapps/shared `sync/tree-dnd.ts`) in render. That's why
// the tree math needs no worklet-ification and no row arrays cross the JSI
// boundary: the expensive thing stays smooth, the smart thing stays plain JS, and
// the pure helpers stay the identical ones web runs.
//
// ACTIVATION is a long press on a dedicated grip handle, both halves deliberate:
//  - the GRIP (not the row) keeps the rename TextInput and the kebab tappable,
//    the same reason web puts its dnd listeners only on the grip;
//  - the LONG PRESS is what lets the rows live inside the page ScrollView
//    (scroll-host.tsx) without fighting it — under 200ms a flick that starts on
//    the grip still scrolls the page, after it the pan claims the gesture
//    outright. It's also the platform idiom (Reminders, Files), and gives an
//    unambiguous "lifted" moment.
//
// Rows are assumed UNIFORM in height (they are — identical size-9 controls around
// a single-line input), so one measured `rowHeight` drives all the math; it's
// measured rather than hardcoded so Dynamic Type can't break it.
//
// Not here, deliberately: haptics. `onPickUp` and `projectOffsetX` are exactly
// the seams a tick hangs off (pick-up, and each level change), but expo-haptics
// is a native module and a prebuild — a dependency decision, not a code one.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard, type LayoutChangeEvent, View } from 'react-native';
import { Gesture, GestureDetector, type PanGesture } from 'react-native-gesture-handler';
import Animated, {
  clamp,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
// The UI→JS hop lives here now: reanimated's `runOnJS` re-export is deprecated,
// and so is worklets' own `runOnJS` — `scheduleOnRN` is the current spelling
// (same thing, args passed inline instead of to a returned function).
import { scheduleOnRN } from 'react-native-worklets';
import { GripVertical } from 'lucide-react-native';

import { Icon } from '../../components/ui/icon';
import { useSettingsScroll } from './scroll-host';

// Row height until the first onLayout lands: a size-9 control plus py-1 either
// side, which is what both tables' rows measure.
const FALLBACK_ROW_HEIGHT = 44;
// Hold before the drag takes over from the page scroll.
const LONG_PRESS_MS = 200;
// How long the lifted row takes to settle into its slot on release. Long enough
// to read as a landing, short enough that the store's write usually lands first.
const SETTLE_MS = 140;
// The neighbours' gap-opening shift, and the lifted row's indent slide.
const SHIFT_MS = 120;
// Auto-scroll: the band at each end of the viewport that pulls the page, the px
// per frame at the very edge (eased in across the band), and the loop's period.
const EDGE_BAND = 72;
const EDGE_SPEED = 12;
const EDGE_FRAME_MS = 16;

export interface DragSortOptions {
  // Rows currently rendered. Changes mid-drag on the Lists table (the lifted
  // row's subtree is dropped while it travels), which is why it's a live prop
  // and not a start-of-drag snapshot.
  count: number;
  // Set to the table's px-per-indent to get horizontal notifications (Lists);
  // omit for a vertical-only drag (Tags), which then never re-renders mid-drag.
  indentWidth?: number;
  // The lifted row's index, once the long press has claimed it. Only a section
  // that keeps its own drag state needs it (Lists maps it to an id, to drop that
  // row's descendants from the render).
  onPickUp?: (index: number) => void;
  // The discrete state changed mid-drag: the slot the row would take now, and
  // its horizontal travel in px. Answer with how far the lifted row should SLIDE
  // horizontally from its own indent — the Lists section runs the shared
  // projection and returns `(projectedDepth - ownDepth) * INDENT_WIDTH`, so the
  // row visibly steps between levels as it's dragged. Returning a px offset (not
  // a depth) keeps this hook free of any tree knowledge, and the section free of
  // shared-value plumbing.
  projectOffsetX?: (to: number, offsetX: number) => number;
  // Released: the slot it would take and its horizontal travel. Not called when
  // the gesture is cancelled.
  onDrop: (from: number, to: number, offsetX: number) => void;
  // Fires once the row has landed — after onDrop, or alone on a cancel. Only a
  // section that keeps its own drag state (Lists, which excludes the lifted
  // row's subtree) needs it.
  onRelease?: () => void;
}

export interface DragSortRow {
  pan: PanGesture;
  style: ReturnType<typeof useAnimatedStyle>;
  onLayout: (e: LayoutChangeEvent) => void;
}

export interface DragSort {
  // Index of the lifted row on the JS side; null when idle. Drives the section's
  // own state (which row to exclude, which to style as lifted) — never the
  // animations, which read the shared values directly.
  activeIndex: number | null;
  // Called by each row component (unconditionally, it's a hook): the grip's
  // gesture, the row's animated style, and the height measurement.
  useRow: (index: number) => DragSortRow;
}

export function useDragSort(options: DragSortOptions): DragSort {
  const { count, indentWidth } = options;
  const scroll = useSettingsScroll();
  // Capture the shared value alone, never the handle: worklets may close over
  // shared values, not over an object carrying JS methods. The handle itself is
  // reached through a ref, so every callback below — and therefore every row's
  // gesture — stays stable for the hook's lifetime.
  const hostScrollY = scroll?.scrollY ?? null;
  const scrollRef = useRef(scroll);
  scrollRef.current = scroll;

  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const active = useSharedValue(-1); // lifted row's index, UI-thread side
  const translationY = useSharedValue(0);
  const translationX = useSharedValue(0);
  const absoluteY = useSharedValue(0); // window coords, for the edge bands
  const scrollAtStart = useSharedValue(0);
  const rowHeight = useSharedValue(FALLBACK_ROW_HEIGHT);
  const depthOffset = useSharedValue(0); // lifted row's projected indent slide
  const settling = useSharedValue(false);
  const rowCount = useSharedValue(count);

  // Written in an effect, not in render — Reanimated rejects render-phase writes.
  useEffect(() => {
    rowCount.value = count;
  }, [count, rowCount]);

  // Latest callbacks, so the gesture (rebuilt only when its row index moves)
  // never closes over a stale render's handlers.
  const handlers = useRef(options);
  handlers.current = options;

  // The page scrolls under the drag, so the finger's travel is its own
  // translation PLUS however far the content moved beneath it. Derived rather
  // than written in onUpdate because auto-scroll moves the content while the
  // finger holds still — there'd be no gesture event to recompute on.
  const dragY = useDerivedValue(
    () => translationY.value + ((hostScrollY?.value ?? 0) - scrollAtStart.value),
  );

  // Which slot the row would take. Uniform rows ⇒ whole steps of rowHeight.
  const target = useDerivedValue(() => {
    if (active.value < 0) return -1;
    const steps = Math.round(dragY.value / rowHeight.value);
    return clamp(active.value + steps, 0, Math.max(0, rowCount.value - 1));
  });

  // The discrete half, handed to JS only when it actually changes. The
  // horizontal trigger is deliberately FINER than any depth threshold: half an
  // indent can't miss a level change (the shallowest threshold that exists is
  // 0.5), while costing at most a few callbacks per indent crossed. The real
  // depth is still the section's own `getProjection` over the px offset — this
  // only decides WHEN to ask.
  const notify = useCallback(
    (to: number, offsetX: number) => {
      const px = handlers.current.projectOffsetX?.(to, offsetX);
      if (px !== undefined) depthOffset.value = withTiming(px, { duration: SHIFT_MS });
    },
    [depthOffset],
  );
  useAnimatedReaction(
    () => {
      if (active.value < 0) return null;
      const bucket = indentWidth ? Math.round(translationX.value / (indentWidth / 2)) : 0;
      return { to: target.value, bucket, offsetX: translationX.value };
    },
    (next, prev) => {
      if (!next) return;
      if (prev && next.to === prev.to && next.bucket === prev.bucket) return;
      scheduleOnRN(notify, next.to, next.offsetX);
    },
  );

  // --- auto-scroll ---------------------------------------------------------
  // A JS-side frame loop rather than reanimated's `scrollTo`: the page scroller
  // is keyboard-controller's composite, not an Animated.ScrollView a worklet can
  // be handed. It runs only while a row is lifted, and only near the ends.
  const edgeTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopAutoScroll = useCallback(() => {
    if (edgeTimer.current === null) return;
    clearInterval(edgeTimer.current);
    edgeTimer.current = null;
  }, []);
  const startAutoScroll = useCallback(() => {
    if (!scrollRef.current || edgeTimer.current !== null) return;
    edgeTimer.current = setInterval(() => {
      const host = scrollRef.current;
      if (!host) return;
      const { top, height } = host.viewport();
      if (height === 0) return;
      const y = absoluteY.value;
      const intoTop = top + EDGE_BAND - y;
      const intoBottom = y - (top + height - EDGE_BAND);
      const dy =
        intoTop > 0
          ? -EDGE_SPEED * Math.min(1, intoTop / EDGE_BAND)
          : intoBottom > 0
            ? EDGE_SPEED * Math.min(1, intoBottom / EDGE_BAND)
            : 0;
      if (dy !== 0) host.scrollBy(dy);
    }, EDGE_FRAME_MS);
    // `absoluteY` is a shared value — reading `.value` each tick is the point,
    // and it can't be a dependency (mutating it doesn't re-render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  // --- lifecycle, JS side --------------------------------------------------
  const handlePickUp = useCallback(
    (index: number) => {
      Keyboard.dismiss(); // a rename field mid-edit would fight the drag
      setActiveIndex(index);
      scrollRef.current?.setScrollEnabled(false);
      startAutoScroll();
      handlers.current.onPickUp?.(index);
    },
    [startAutoScroll],
  );

  const handleDrop = useCallback(
    (from: number, to: number, offsetX: number) => {
      // The page stops chasing the finger the moment it lifts; scrolling stays
      // locked through the settle so a stray touch can't yank the viewport.
      stopAutoScroll();
      handlers.current.onDrop(from, to, offsetX);
    },
    [stopAutoScroll],
  );

  const handleRelease = useCallback(() => {
    stopAutoScroll();
    scrollRef.current?.setScrollEnabled(true);
    setActiveIndex(null);
    handlers.current.onRelease?.();
  }, [stopAutoScroll]);

  // --- per-row wiring ------------------------------------------------------
  const useRow = (index: number): DragSortRow => {
    const pan = useMemo(
      () =>
        Gesture.Pan()
          .activateAfterLongPress(LONG_PRESS_MS)
          .onStart(() => {
            active.value = index;
            settling.value = false;
            translationY.value = 0;
            translationX.value = 0;
            depthOffset.value = 0;
            scrollAtStart.value = hostScrollY?.value ?? 0;
            scheduleOnRN(handlePickUp, index);
          })
          .onUpdate((e) => {
            translationY.value = e.translationY;
            translationX.value = e.translationX;
            absoluteY.value = e.absoluteY;
          })
          .onEnd(() => {
            scheduleOnRN(handleDrop, active.value, target.value, translationX.value);
          })
          .onFinalize(() => {
            // Nothing was ever lifted (the long press didn't land) — the pan
            // never activated, so there's no state to unwind.
            if (active.value < 0) return;
            // Let the lifted row land in its slot before the state unwinds:
            // clearing `active` immediately would snap every row back to identity
            // a frame or two before the store's write repaints them in the new
            // order. The gap stays open while the row flies into it.
            settling.value = true;
            const landed = (target.value - active.value) * rowHeight.value;
            translationY.value = withTiming(landed, { duration: SETTLE_MS }, () => {
              active.value = -1;
              settling.value = false;
              translationY.value = 0;
              translationX.value = 0;
              depthOffset.value = 0;
              scheduleOnRN(handleRelease);
            });
          }),
      // The row's own index is the only thing here that can change: the shared
      // values are created once, the three handlers are stable (they reach the
      // scroll host through a ref), and the section's own callbacks are read
      // fresh off `handlers.current` at call time.
      [index],
    );

    // Every branch returns the same style keys so no property is ever left
    // stranded at its last animated value.
    const style = useAnimatedStyle(() => {
      const idle = { transform: [{ translateY: 0 }, { translateX: 0 }, { scale: 1 }], zIndex: 0 };
      if (active.value < 0) return idle;

      if (index === active.value) {
        return {
          transform: [
            // dragY, not translationY: the row is a child of the scrolling
            // content, so it has to out-travel the content to stay under the
            // finger. Once released it flies to a fixed slot instead.
            { translateY: settling.value ? translationY.value : dragY.value },
            { translateX: depthOffset.value },
            { scale: settling.value ? 1 : 1.02 },
          ],
          // Both axes of "on top": zIndex orders siblings on iOS, elevation on
          // Android (where it also casts the lift shadow).
          zIndex: 2,
          elevation: 4,
        };
      }

      // Everyone between the lifted row's old slot and its new one shifts by
      // exactly one row, opening the gap it will drop into.
      const shift =
        index > active.value && index <= target.value
          ? -rowHeight.value
          : index < active.value && index >= target.value
            ? rowHeight.value
            : 0;
      return {
        transform: [
          { translateY: withTiming(shift, { duration: SHIFT_MS }) },
          { translateX: 0 },
          { scale: 1 },
        ],
        zIndex: 0,
      };
    });

    const onLayout = useCallback(
      (e: LayoutChangeEvent) => {
        const height = e.nativeEvent.layout.height;
        if (height > 0 && Math.abs(height - rowHeight.value) > 0.5) rowHeight.value = height;
      },
      // rowHeight is a shared value from the enclosing hook — created once.
      [],
    );

    return { pan, style, onLayout };
  };

  return { activeIndex, useRow };
}

// The wrapper every draggable row renders as. Uniwind styles reanimated
// components directly, so `className` works exactly as it does on a plain View.
export const DragRow = Animated.View;

// The grip. Same footprint as the row's other controls, and the ONLY thing
// carrying the pan — web puts its dnd listeners only on the grip for the same
// reason: everything else in the row stays immediately tappable.
export function DragHandle({ pan }: { pan: PanGesture }) {
  return (
    <GestureDetector gesture={pan}>
      <View aria-label="Drag to reorder" className="size-9 items-center justify-center rounded-md">
        <Icon as={GripVertical} className="size-4 text-muted-foreground" />
      </View>
    </GestureDetector>
  );
}
