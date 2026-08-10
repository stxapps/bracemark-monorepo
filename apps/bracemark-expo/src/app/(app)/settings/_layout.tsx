import { Drawer } from 'expo-router/drawer';

import { Sidebar } from '../../../features/settings/sidebar';

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
export default function SettingsLayout() {
  return (
    <Drawer
      drawerContent={(props) => <Sidebar closeDrawer={() => props.navigation.closeDrawer()} />}
      screenOptions={{ headerShown: false }}
    />
  );
}
