import { Drawer } from 'expo-router/drawer';

import { LinksPageProvider } from '../../../features/links/page-provider';
import { Sidebar } from '../../../features/links/sidebar';

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
export default function LinksLayout() {
  return (
    <LinksPageProvider>
      <Drawer
        drawerContent={(props) => <Sidebar closeDrawer={() => props.navigation.closeDrawer()} />}
        screenOptions={{ headerShown: false }}
      />
    </LinksPageProvider>
  );
}
