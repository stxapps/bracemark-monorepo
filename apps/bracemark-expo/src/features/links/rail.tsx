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
//  - NO DRAG-TO-RESIZE. Web's splitter is a pointer affordance found by hover;
//    a touch screen has neither the hover nor the precision, and the rail's
//    width feeds the card grid's column count, so a drag would re-compose it
//    per frame. One width, `RAIL_WIDTH` (lib/window-class.ts).
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
import { AccessibilityInfo, type View } from 'react-native';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react-native';

import { readSidebarRailCollapsed, writeSidebarRailCollapsed } from '@stxapps/expo-react';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { useWideWindow } from '../../lib/window-class';

type FocusTarget = 'show' | 'hide';

type LinksRail = {
  // The window is wide enough to dock (lib/window-class.ts).
  wide: boolean;
  // The rail is docked right now — wide AND not put away. The width the list
  // pane loses to it is `RAIL_WIDTH` exactly when this is true.
  docked: boolean;
  setCollapsed: (collapsed: boolean) => void;
  // Read-once focus hand-off between the two buttons (below).
  takeFocus: (target: FocusTarget) => boolean;
};

const LinksRailContext = createContext<LinksRail | null>(null);

export function LinksRailProvider({ children }: { children: ReactNode }) {
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

  const value = useMemo(
    () => ({ wide, docked: wide && !collapsed, setCollapsed, takeFocus }),
    [wide, collapsed, setCollapsed, takeFocus],
  );
  return <LinksRailContext.Provider value={value}>{children}</LinksRailContext.Provider>;
}

export function useLinksRail(): LinksRail {
  const rail = useContext(LinksRailContext);
  if (!rail) throw new Error('useLinksRail must be used within LinksRailProvider');
  return rail;
}

// Accessibility focus onto the button as it mounts, when the hand-off names it.
// A CALLBACK ref, typed `unknown`: ButtonProps types `ref` as the intersection of
// a View ref and a ref to Pressable's component type (ui/button.tsx), which no
// object ref satisfies, and the host it receives is the Pressable's View.
function useFocusOnMount(target: FocusTarget) {
  const { takeFocus } = useLinksRail();
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
  const { setCollapsed } = useLinksRail();
  const ref = useFocusOnMount('hide');
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon-sm"
      testID="links-hide-rail"
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
  const { setCollapsed } = useLinksRail();
  const ref = useFocusOnMount('show');
  return (
    <Button
      ref={ref}
      variant="ghost"
      size="icon-sm"
      testID="links-show-rail"
      aria-label="Show sidebar"
      onPress={() => setCollapsed(false)}
      hitSlop={6}
      className="-ml-1"
    >
      <Icon as={PanelLeftOpen} className="size-5 text-foreground" />
    </Button>
  );
}
