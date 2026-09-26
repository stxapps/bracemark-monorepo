import { Drawer } from 'expo-router/drawer';

import { LiveReadPause } from '@stxapps/expo-react';

import { LinksPageProvider } from '../../../features/links/page-provider';
import { Sidebar } from '../../../features/links/sidebar';
import { usePausedWhileCovered } from '../../../features/links/use-paused-while-covered';

// The links section's frame — the expo analogue of bracemark-web's two-pane links
// page (`(app)/links/page.tsx`): web's always-visible sidebar becomes a Drawer
// (swipe from the left edge, or the topbar's menu button), with the same
// lists/tags/Show All content as its drawerContent. LinksPageProvider wraps the
// NAVIGATOR (not the screen) because the drawer content needs the same
// selection context the screen reads — it highlights the active row and
// commits selections via setSimpleQuery.
//
// The drawer's swipe gesture is why GestureHandlerRootView wraps the root
// layout (src/app/_layout.tsx).
//
// LiveReadPause stops the section's live reads while another screen covers it
// (features/links/use-paused-while-covered.ts), so a write made from Settings
// doesn't re-render a links screen nobody can see.
export default function LinksLayout() {
  const paused = usePausedWhileCovered();
  return (
    <LiveReadPause paused={paused}>
      <LinksPageProvider>
        <Drawer
          drawerContent={(props) => <Sidebar closeDrawer={() => props.navigation.closeDrawer()} />}
          screenOptions={{ headerShown: false }}
        />
      </LinksPageProvider>
    </LiveReadPause>
  );
}
