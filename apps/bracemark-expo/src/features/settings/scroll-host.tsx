// The settings page's scrolling frame, plus the handle a drag surface inside it
// needs. Every section renders inside one page ScrollView, which is the whole
// reason this exists: bracemark-web's drag layer lives on a document that scrolls
// itself, but here the rows being dragged are children of a scroll view, and the
// two have to cooperate on three things —
//
//  1. the CONTENT MOVES UNDER THE FINGER. When the page auto-scrolls, a
//     stationary finger is over a different row than it was; `scrollY` is a
//     shared value so the drag math can add the scroll delta to the gesture's
//     own translation (drag-sort.tsx's `dragY`).
//  2. AUTO-SCROLL. Dragging a row to a slot that's off-screen has to move the
//     page — `scrollBy` is the JS-side edge-scroll primitive, clamped to the
//     content so the loop stops at the ends.
//  3. the page must NOT scroll while a row is being dragged (`setScrollEnabled`).
//     The long-press activation already wins the gesture, but auto-scroll needs
//     to be the only thing moving the viewport.
//
// The ScrollView lives here rather than in the route (`(app)/settings/
// [section].tsx`) so all of that stays in one file and the route stays thin, as
// its convention says. The wrapper View is what gets measured: keyboard-
// controller claims the scroll view's own `onLayout`, and edge detection needs
// the viewport's position in WINDOW coordinates anyway (to compare against the
// gesture's `absoluteY`), which a layout event can't give — it's parent-relative.
//
// `useSettingsScroll()` returns null outside a host (a section rendered in a test
// or another frame still works — it just gets no auto-scroll), so every consumer
// must treat the handle as optional.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type NativeScrollEvent, type NativeSyntheticEvent, ScrollView, View } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { type SharedValue, useSharedValue } from 'react-native-reanimated';
import { withUniwind } from 'uniwind';

// Composites (not core hosts) need Uniwind's HOC to accept `className` — the
// auth screens' pattern, including keyboard-controller's scroll view so a
// focused field (rename, passwords) stays clear of the keyboard.
const StyledKeyboardAwareScrollView = withUniwind(KeyboardAwareScrollView);

export interface SettingsScrollHandle {
  // Live scroll offset, on the UI thread — read from worklets.
  scrollY: SharedValue<number>;
  // Scroll by `dy` px (no animation — this is called every frame while
  // auto-scrolling), clamped to the scrollable range. Returns the delta actually
  // applied, so a caller can tell when the content has run out.
  scrollBy: (dy: number) => number;
  // The viewport in window coordinates, for comparing against a gesture's
  // `absoluteY`. Height is 0 until the first layout.
  viewport: () => { top: number; height: number };
  setScrollEnabled: (enabled: boolean) => void;
}

const SettingsScrollContext = createContext<SettingsScrollHandle | null>(null);

export function useSettingsScroll(): SettingsScrollHandle | null {
  return useContext(SettingsScrollContext);
}

export function SettingsScrollHost({ children }: { children: ReactNode }) {
  const wrapperRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);

  const scrollY = useSharedValue(0);
  // Real state, not setNativeProps: on the new architecture setNativeProps is a
  // no-op, and this flips exactly twice per drag. `children` is the same element
  // on both renders, so React bails out of re-rendering the section under it.
  const [scrollEnabled, setScrollEnabled] = useState(true);
  // JS-side mirrors of what the worklets don't need. Refs, not state: they change
  // on every scroll frame and nothing renders from them.
  const offsetY = useRef(0);
  const contentHeight = useRef(0);
  const viewportTop = useRef(0);
  const viewportHeight = useRef(0);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      offsetY.current = e.nativeEvent.contentOffset.y;
      scrollY.value = offsetY.current;
    },
    [scrollY],
  );

  const handle = useMemo<SettingsScrollHandle>(
    () => ({
      scrollY,
      scrollBy: (dy) => {
        // Clamp to the scrollable range so the auto-scroll loop can't push past
        // either end (and can detect that it did nothing).
        const max = Math.max(0, contentHeight.current - viewportHeight.current);
        const next = Math.min(max, Math.max(0, offsetY.current + dy));
        const applied = next - offsetY.current;
        if (applied === 0) return 0;
        // Move both mirrors now rather than waiting for the scroll event: the
        // next frame of the loop reads them, and onScroll may lag a frame.
        offsetY.current = next;
        scrollY.value = next;
        scrollRef.current?.scrollTo({ y: next, animated: false });
        return applied;
      },
      viewport: () => ({ top: viewportTop.current, height: viewportHeight.current }),
      setScrollEnabled,
    }),
    [scrollY],
  );

  return (
    <View
      ref={wrapperRef}
      className="min-h-0 flex-1"
      // Re-measure on every layout (rotation, keyboard, tab bar): the window
      // position can't be read from the layout event, which is parent-relative.
      onLayout={() => {
        wrapperRef.current?.measureInWindow((_x, y, _width, height) => {
          viewportTop.current = y;
          viewportHeight.current = height;
        });
      }}
    >
      <SettingsScrollContext.Provider value={handle}>
        <StyledKeyboardAwareScrollView
          ref={scrollRef}
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          bottomOffset={16}
          scrollEnabled={scrollEnabled}
          // keyboard-controller forces scrollEventThrottle={16} and claims the
          // scroll view's own onLayout (which is why the viewport is measured on
          // the wrapper above); onScroll rides through untouched.
          onScroll={onScroll}
          onContentSizeChange={(_w, h) => {
            contentHeight.current = h;
          }}
        >
          {children}
        </StyledKeyboardAwareScrollView>
      </SettingsScrollContext.Provider>
    </View>
  );
}
