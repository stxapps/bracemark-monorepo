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
// It also owns the SECTION SWITCH, because it owns the offset: `resetKey` is the
// section id, and a change in it puts the page back at the top (see the effect
// below for why nothing else does that here). A section's SUB-VIEW switch
// (Account → Change password) is the same event one level down, but it is local
// state this host never sees — SettingsPane's `viewKey` calls `scrollToTop` for it.
//
// `useSettingsScroll()` returns null outside a host (a section rendered in a test
// or another frame still works — it just gets no auto-scroll), so every consumer
// must treat the handle as optional.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
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
  // Bring a node in the page into view, animated, and only if it isn't already
  // — what something that can APPEAR off-screen needs (SettingsNotice; nothing
  // else uses it yet). The node is measured against this host's own box rather
  // than in window coordinates (see the implementation for why that distinction
  // is load-bearing), so a caller passes its ref and nothing else. Animated,
  // unlike `scrollBy`: that one runs per frame inside a drag loop, this one
  // runs once and the movement is the point — a page that jumps has not told
  // the user anything.
  scrollIntoView: (node: View | null) => void;
  // Jump to the top, unanimated — "this is different content now". The section
  // switch below uses it, and so does a section's own in-place view swap
  // (SettingsPane's `viewKey`), which this host can't see.
  scrollToTop: () => void;
  setScrollEnabled: (enabled: boolean) => void;
}

// The gap left above a node scrolled into view, and below one scrolled up to.
// 16 is THIS surface's own step, not a number picked for this one scroll: it is
// the `gap-4` SettingsPane already puts between a heading and its content
// (settings-kit.tsx), and it is the `bottomOffset` on the scroll view below —
// the same question asked about the keyboard, which is how much air a thing
// needs from the edge that would otherwise crowd it.
//
// IT IS NOT THE WEB TWIN'S NUMBER, and the resemblance is a trap worth naming.
// web's scroller carries `scroll-pt-18` — 72px, which is 56 PLUS 16 — because
// its topbar is `sticky top-0` INSIDE the scroller and covers the top 56px of
// the scrollport, so the 56 is a FLOOR that a taller bar has to drag up with it
// (bracemark-web `(app)/settings/layout.tsx`, docs/editors.md). Here the topbar
// is a SIBLING of this host (`(app)/settings/[section].tsx`) and the scrollport
// starts below it: nothing is obscured, so there is no floor in this number and
// nothing to keep in sync with the bar's height. Only the air is shared between
// the two platforms, and this is the air.
//
// Unlike web's, this margin is SYMMETRIC — one constant sets the top landing
// gap, the bottom one, and the `fits` threshold, where web pads only the top
// (`scroll-padding-bottom` stays 0). So it also sets how close to an edge a node
// still counts as ALREADY VISIBLE, and raising it widens the band that moves: a
// notice sitting just inside the old margin now gets a short animated nudge
// instead of staying put. That is the cost to weigh before this climbs again —
// the common case is a short pane where nothing should move at all.
const SCROLL_INTO_VIEW_MARGIN = 16;

const SettingsScrollContext = createContext<SettingsScrollHandle | null>(null);

export function useSettingsScroll(): SettingsScrollHandle | null {
  return useContext(SettingsScrollContext);
}

export function SettingsScrollHost({
  resetKey,
  children,
}: {
  // The identity of the page under this scroller — the section id from the route.
  // A change in it means different content, so the offset resets (see below).
  resetKey: string;
  children: ReactNode;
}) {
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

  // Put the page back at the top when the SECTION changes. Not optional polish:
  // the sidebar's pick is a `router.push('/settings/<id>')` into a Drawer, and
  // expo-router demotes a push to a navigate there (docs/search.md, _leaving the
  // page and coming back_) — a drawer's router reuses the route KEY when only the
  // params move, so the one `[section]` screen RE-RENDERS rather than remounting
  // and this ScrollView keeps the offset the previous section left. Open Lists,
  // scroll down its table, pick About: a three-line page arrives scrolled past
  // its own end, or clamped to a middle the user never chose. Nothing reports it
  // — the offset is a valid offset, and the section that rendered is the section
  // that was asked for.
  //
  // Web needs no equivalent and that is why this is easy to lose: its `<main>` is
  // in the layout and stays mounted across the same navigation, but Next's app
  // router scrolls the new segment into view on every one, which walks every
  // overflow ancestor — so the port is where the behaviour has to be spelled out.
  //
  // Same shape as the links pane's view-change reset (`features/links/main.tsx`,
  // web's `useScrollTopOnQuery`): an effect on the identity that means "different
  // content", guarded by a prev-ref so the host's other renders (a drag locking
  // the scroll, a keyboard) leave the user's position alone. `animated: false` —
  // this is a page replacing another under a closing drawer, not a movement the
  // user should watch.
  //
  // The JS mirrors move with it for `scrollBy`'s reason: the next drag frame or
  // `scrollIntoView` call reads them and `onScroll` can lag a frame behind.
  const scrollToTop = useCallback(() => {
    offsetY.current = 0;
    scrollY.value = 0;
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [scrollY]);

  const prevResetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (prevResetKeyRef.current === resetKey) return;
    prevResetKeyRef.current = resetKey;
    scrollToTop();
  }, [resetKey, scrollToTop]);

  const handle = useMemo<SettingsScrollHandle>(
    () => ({
      scrollY,
      scrollToTop,
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
      scrollIntoView: (node) => {
        // Before the wrapper's first layout there is no viewport to scroll
        // within, and measuring against a 0-height one would scroll to the top
        // of the page for any node at all.
        const wrapper = wrapperRef.current;
        if (!node || !wrapper || viewportHeight.current === 0) return;
        // MEASURED AGAINST THE WRAPPER, AND `y` COMES BACK IN CONTENT
        // COORDINATES — the node's offset from the top of everything the
        // scroller holds, which does NOT move as the user scrolls.
        // `measureLayout` sums layout boxes up the tree and a scroll offset is
        // not one of them. Driven on the simulator: with the page scrolled a
        // screen down, the notice measured 156 either way, so comparing it
        // against the viewport's own box said "already visible" every time and
        // this method did nothing at all — silently, since there is no failure
        // to see, only a page that stays put. Hence the comparison below is
        // against the WINDOW OF CONTENT on screen (`offsetY` … `+ height`), and
        // the target is an absolute offset rather than a delta.
        //
        // Window coordinates are the other road, and it is worse: this wrapper
        // sits inside a `SafeAreaView`, which applies its insets as a NATIVE
        // view outside Yoga (docs/soft-keyboard.md, _the traps_), so measuring
        // the node one way and the viewport the other mixes two frames that
        // differ by the top inset. Everything here is one tree and one frame.
        node.measureLayout(wrapper, (_x, y, _width, height) => {
          const visibleTop = offsetY.current + SCROLL_INTO_VIEW_MARGIN;
          const visibleBottom = offsetY.current + viewportHeight.current - SCROLL_INTO_VIEW_MARGIN;
          // A node TALLER than the viewport can never be "fully" in view, and
          // its top is the end that has to be readable — so its top edge being
          // in view is the whole test.
          const fits = height <= viewportHeight.current - 2 * SCROLL_INTO_VIEW_MARGIN;
          // Already in view: leave the page exactly where the user put it.
          if (y >= visibleTop && (y + height <= visibleBottom || !fits)) return;
          // Nearest edge, as the web twin's `block: 'nearest'` does: a node
          // above the fold scrolls up to it, one below scrolls only as far as
          // it takes to clear the bottom.
          const target =
            y < visibleTop || !fits
              ? y - SCROLL_INTO_VIEW_MARGIN
              : y + height + SCROLL_INTO_VIEW_MARGIN - viewportHeight.current;
          const max = Math.max(0, contentHeight.current - viewportHeight.current);
          const next = Math.min(max, Math.max(0, target));
          if (next === offsetY.current) return;
          scrollRef.current?.scrollTo({ y: next, animated: true });
        });
      },
      setScrollEnabled,
    }),
    [scrollY, scrollToTop],
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
          keyboardDismissMode="on-drag"
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
