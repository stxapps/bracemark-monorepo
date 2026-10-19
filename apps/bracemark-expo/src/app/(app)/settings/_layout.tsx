import { Drawer } from 'expo-router/drawer';

import { Sidebar } from '../../../features/settings/sidebar';
import { RAIL_WIDTH, useWideWindow } from '../../../lib/window-class';

// The settings section's frame — the expo analogue of bracemark-web's
// `(app)/settings/layout.tsx`: web's always-visible section sidebar becomes a
// Drawer (swipe from the left edge, or the topbar's menu button), with the
// section menu as its drawerContent — the same shape as the links group's
// _layout. The active section lives in the URL PATH (`/settings/lists`, …), so
// a section is a real, linkable destination; the sidebar reads it from the
// pathname and each section screen reads it from its route param — the URL is
// the single source of truth, exactly like web.
//
// The drawer's swipe gesture is why GestureHandlerRootView wraps the root
// layout (src/app/_layout.tsx).
//
// On a WIDE window (lib/window-class.ts) the Drawer is `permanent` — the section
// menu docked beside the pane, web's two-pane settings frame. Unlike the links
// rail it cannot be put away: web's settings rail can't either, being seven short
// destinations with nothing to truncate (docs/safe-area.md). Same width as the
// links rail, so crossing between the two surfaces moves nothing, and the same
// `borderRightWidth: 0` for the reason the links layout gives — the Sidebar
// draws its own edge in the token.
export default function SettingsLayout() {
  const wide = useWideWindow();
  return (
    <Drawer
      drawerContent={(props) => <Sidebar closeDrawer={() => props.navigation.closeDrawer()} />}
      screenOptions={{
        headerShown: false,
        drawerType: wide ? 'permanent' : 'front',
        drawerStyle: wide ? { width: RAIL_WIDTH, borderRightWidth: 0 } : undefined,
      }}
    />
  );
}
