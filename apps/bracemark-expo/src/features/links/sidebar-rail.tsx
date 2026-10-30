// The links rail on a WIDE window — the expo port of bracemark-web's docked
// rail (`(app)/links/_hooks/use-sidebar-rail.ts`, `_panes/sidebar.tsx`'s
// HideRailButton, `_panes/topbar.tsx`'s ShowRailButton). Below
// `WIDE_MIN_WIDTH` (lib/window-class.ts) the rail is the Drawer it always was;
// at or above it, `(app)/links/_layout.tsx` turns the same Drawer `permanent`,
// so the identical Sidebar sits beside the list instead of over it, and the
// user can put it away and bring it back. docs/safe-area.md, _wide windows on
// native_.
//
// What carries over from web and what doesn't:
//
//  - COLLAPSED takes the narrow shape at full width, as on web: the Drawer
//    goes back to `front`, the list gets the whole window, the topbar's
//    leading slot docks the rail again, and an edge swipe still slides the rail
//    over the list for a one-off pick. The state is device-local
//    (`sidebar_view.railCollapsed`, expo-react sidebar-view-store — wiped on
//    sign-out with the collapse ids, like web's) and read on the MOUNTING
//    render, never in an effect, for web's reason: a user who put the rail away
//    would otherwise watch it appear and vanish on every visit, and the card
//    grid under it would re-compose twice.
//  - STEPPED, NOT DRAGGED FREE. Web's splitter is a pointer affordance found by
//    hover; a touch screen has neither the hover nor the precision, and the
//    rail's width feeds the card grid's column count, so a free drag would
//    re-compose it per frame. So the edge carries a grip (`RailWidthHandle`)
//    whose drag SNAPS between five widths, 240 to 400 in 40s — the rail jumps
//    as the finger crosses a midpoint, re-composing the grid once per snap — and
//    commits on release. Past half the narrowest it collapses on release, like web's drag
//    shut; a double-tap returns the shape's default. Screen readers get the same
//    steps as an adjustable control. The steps, the per-shape memory and the
//    per-window limit are lib/rail-width.ts's (`useRailWidth`).
//  - NO SHORTCUT. Web's ⌘\ needs a hardware keyboard; on an iPad with one, the
//    two buttons are reachable by Full Keyboard Access like any control.
//
// THE ROW PRESS STILL CALLS `closeDrawer`, docked or not. On a permanent drawer
// react-navigation pins `open` regardless of state, so the call is a no-op
// there, and the Sidebar does not have to know which host it is in — the same
// arrangement as web, where both hosts render one SidebarBody.

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
import { AccessibilityInfo, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react-native';

import {
  readSidebarRailCollapsed,
  writeSidebarRailCollapsed,
  writeSidebarRailWidth,
} from '@stxapps/expo-react';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import {
  railDragRelease,
  railDragTarget,
  railWidthLabel,
  useRailWidth,
  type WindowShape,
} from '../../lib/rail-width';
import { cn } from '../../lib/utils';
import { useWideWindow } from '../../lib/window-class';

type FocusTarget = 'show' | 'hide';

type SidebarRail = {
  // The window is wide enough to dock (lib/window-class.ts).
  wide: boolean;
  // The rail is docked right now — wide AND not put away. The width the list
  // pane loses to it is `width` exactly when this is true.
  docked: boolean;
  // The docked width as drawn: the step a drag is over, else `settledWidth`.
  width: number;
  // The stored width for this window's shape, resolved against the window
  // (lib/rail-width.ts) — what the rail rests at, drag or no drag.
  settledWidth: number;
  // The widths this window offers, narrowest first.
  steps: readonly number[];
  shape: WindowShape;
  // Remember a width for this window's shape; `null` returns it to the default.
  setWidth: (width: number | null) => void;
  // What a drag on the edge is over right now — a step, the collapse zone past
  // the narrowest, or nothing while no drag is under way.
  dragTarget: number | 'collapse' | null;
  setDragTarget: (target: number | 'collapse' | null) => void;
  setCollapsed: (collapsed: boolean) => void;
  // Read-once focus hand-off between the two buttons (below).
  takeFocus: (target: FocusTarget) => boolean;
};

const SidebarRailContext = createContext<SidebarRail | null>(null);

export function SidebarRailProvider({ children }: { children: ReactNode }) {
  const wide = useWideWindow();
  // The lazy initializer IS the mounting-render read the header asks for:
  // drizzle's expo driver is synchronous, and it is one row.
  const [collapsed, setCollapsedState] = useState(readSidebarRailCollapsed);
  const pendingFocus = useRef<FocusTarget | null>(null);

  const setCollapsed = useCallback((next: boolean) => {
    // Each button unmounts the moment it is pressed — Hide is inside the rail it
    // hides, Show only exists while the rail is away — so a screen reader's
    // focus would fall to the top of the screen. The counterpart takes it as it
    // mounts, which is web's hand-off (`takeRailFocus`), done with
    // accessibility focus because a touch screen has no other kind.
    pendingFocus.current = next ? 'show' : 'hide';
    setCollapsedState(next);
    writeSidebarRailCollapsed(next);
  }, []);

  const takeFocus = useCallback((target: FocusTarget) => {
    if (pendingFocus.current !== target) return false;
    pendingFocus.current = null;
    return true;
  }, []);

  const { shape, width: settledWidth, steps } = useRailWidth();
  const [dragTarget, setDragTarget] = useState<number | 'collapse' | null>(null);
  const setWidth = useCallback(
    (width: number | null) => writeSidebarRailWidth(shape, width),
    [shape],
  );
  // Over the collapse zone the rail holds the narrowest width and dims (the
  // layout's `drawerStyle`); it only goes on release.
  const width =
    dragTarget === 'collapse' ? steps[0] : dragTarget === null ? settledWidth : dragTarget;

  const value = useMemo(
    () => ({
      wide,
      docked: wide && !collapsed,
      width,
      settledWidth,
      steps,
      shape,
      setWidth,
      dragTarget,
      setDragTarget,
      setCollapsed,
      takeFocus,
    }),
    [
      wide,
      collapsed,
      width,
      settledWidth,
      steps,
      shape,
      setWidth,
      dragTarget,
      setCollapsed,
      takeFocus,
    ],
  );
  return <SidebarRailContext.Provider value={value}>{children}</SidebarRailContext.Provider>;
}

export function useSidebarRail(): SidebarRail {
  const rail = useContext(SidebarRailContext);
  if (!rail) throw new Error('useSidebarRail must be used within SidebarRailProvider');
  return rail;
}

// Accessibility focus onto the button as it mounts, when the hand-off names it.
// A CALLBACK ref, typed `unknown`: ButtonProps types `ref` as the intersection of
// a View ref and a ref to Pressable's component type (ui/button.tsx), which no
// object ref satisfies, and the host it receives is the Pressable's View.
function useFocusOnMount(target: FocusTarget) {
  const { takeFocus } = useSidebarRail();
  const host = useRef<View | null>(null);
  useEffect(() => {
    if (takeFocus(target) && host.current) {
      AccessibilityInfo.sendAccessibilityEvent(host.current, 'focus');
    }
  }, [takeFocus, target]);
  return useCallback((node: unknown) => {
    host.current = node as View | null;
  }, []);
}

// The rail's dismiss, in the brand row's trailing slot — web's placement. Only
// rendered while docked (the overlay drawer is dismissed the usual three ways).
export function HideRailButton() {
  const { setCollapsed } = useSidebarRail();
  const ref = useFocusOnMount('hide');
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon-sm"
      testID="sidebar-rail-hide"
      aria-label="Hide sidebar"
      onPress={() => setCollapsed(true)}
      // The lockup beside it takes no touches, and the row's `px-4` is free on
      // the right: the full 6 each way reaches 48 (links/topbar.tsx's rule).
      hitSlop={6}
      className="-mr-2 shrink-0"
    >
      <Icon as={PanelLeftClose} className="size-5 text-foreground" />
    </Button>
  );
}

// The topbar's leading slot while the rail is put away on a wide window — where
// the drawer button sits on a phone, so the bar's title holds its place.
export function ShowRailButton() {
  const { setCollapsed } = useSidebarRail();
  const ref = useFocusOnMount('show');
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon-sm"
      testID="sidebar-rail-show"
      aria-label="Show sidebar"
      onPress={() => setCollapsed(false)}
      hitSlop={6}
      className="-ml-1"
    >
      <Icon as={PanelLeftOpen} className="size-5 text-foreground" />
    </Button>
  );
}

// The docked rail's right edge: a grip that steps the width (see the header).
// Rendered by the links layout beside the Sidebar while docked, and kept INSIDE
// the rail's box — react-native-drawer-layout puts the rail in its own view, and
// Android delivers no touch to a child outside its parent's bounds, so a grip
// straddling the edge would be half dead. The grip paints over the Sidebar's
// own `border-r`, so at rest it reads as a thickening of the hairline — and
// in the focus-ring colour while a drag is under way.
//
// The drag is measured in WINDOW coordinates (`absoluteX`) from where it began:
// the grip moves with the rail on every snap, so a translation read against the
// grip itself would jump each time it did.
//
// Horizontal only: `activeOffsetX` waits for 8 of sideways travel, and
// `failOffsetY` gives a vertical one back to the rail's scroller, so a scroll
// that starts on the grip still scrolls.
//
// Taps on the grip are spent on it — a row's "Lock list" button underneath, at
// the grip's height, loses its right-hand quarter. Accepted, for the grip
// being the one thing at that spot that LOOKS like a control.
export function RailWidthHandle() {
  const { width, settledWidth, steps, setWidth, dragTarget, setDragTarget, setCollapsed } =
    useSidebarRail();
  // Built once: a drag outlives renders (each snap is one), so the gesture reads
  // the rail's current state through a ref rather than closing over a render's.
  const start = useRef({ x: 0, width: 0 });
  const target = useRef<number | 'collapse' | null>(null);
  const current = useRef({ width, settledWidth, steps, setWidth, setDragTarget, setCollapsed });
  current.current = { width, settledWidth, steps, setWidth, setDragTarget, setCollapsed };

  const gesture = useMemo(() => {
    const pan = Gesture.Pan()
      .runOnJS(true)
      .activeOffsetX([-8, 8])
      .failOffsetY([-12, 12])
      .onStart((e) => {
        start.current = { x: e.absoluteX, width: current.current.width };
        target.current = null;
      })
      .onUpdate((e) => {
        const next = railDragTarget(
          start.current.width,
          e.absoluteX - start.current.x,
          current.current.steps,
        );
        if (next === target.current) return;
        target.current = next;
        current.current.setDragTarget(next);
      })
      .onEnd((_e, success) => {
        if (!success) return;
        const release = railDragRelease(target.current, current.current.settledWidth);
        if (release === 'collapse') current.current.setCollapsed(true);
        else if (release !== null) current.current.setWidth(release);
      })
      .onFinalize(() => {
        target.current = null;
        current.current.setDragTarget(null);
      });

    const reset = Gesture.Tap()
      .runOnJS(true)
      .numberOfTaps(2)
      .onEnd((_e, success) => {
        if (success) current.current.setWidth(null);
      });

    return Gesture.Race(pan, reset);
  }, []);

  const index = steps.indexOf(settledWidth);
  const stepBy = (delta: number) => {
    const next = steps[index + delta];
    if (next !== undefined) setWidth(next);
  };

  return (
    <GestureDetector gesture={gesture}>
      <View
        testID="sidebar-rail-width"
        // A screen reader's form of the drag: swipe up / down to step it. The
        // collapse stays the Hide button's, which is already in reach.
        // `accessibilityRole`, not `role`: RN's `role` takes the ARIA set, which has
        // no adjustable, and its `slider` would announce a percentage of a
        // range where a named step says more.
        // `accessible`: a View is not an accessibility element by default, so
        // without it VoiceOver skips the grip, role and actions and all.
        accessible
        accessibilityRole="adjustable"
        aria-label="Sidebar width"
        accessibilityValue={{ text: railWidthLabel(settledWidth) }}
        accessibilityActions={[
          { name: 'increment', label: 'Wider' },
          { name: 'decrement', label: 'Narrower' },
        ]}
        onAccessibilityAction={(e) => stepBy(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        className="absolute top-1/2 right-0 -mt-7 h-14 w-6 items-end justify-center"
      >
        <View
          className={cn(
            'h-10 w-1 rounded-full',
            dragTarget === null ? 'bg-muted-foreground/40' : 'bg-ring',
          )}
        />
      </View>
    </GestureDetector>
  );
}
