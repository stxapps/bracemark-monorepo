import { Drawer } from 'expo-router/drawer';

import { LiveReadPause } from '@stxapps/expo-react';

import { SheetCovered, SheetHost } from '../../../components/ui/sheet';
import { LinkAddHost } from '../../../features/links/link-add-host';
import { LinkEditHost } from '../../../features/links/link-edit-host';
import { LinksPageProvider } from '../../../features/links/page-provider';
import { AdvancedSearchHost } from '../../../features/links/search-bar';
import { Sidebar } from '../../../features/links/sidebar';
import {
  HideRailButton,
  RailWidthHandle,
  SidebarRailProvider,
  useSidebarRail,
} from '../../../features/links/sidebar-rail';
import { usePausedWhileCovered } from '../../../features/links/use-paused-while-covered';

// The links section's frame — the expo analogue of bracemark-web's two-pane links
// page (`(app)/links/page.tsx`): on a phone-width window web's sidebar becomes a
// Drawer (swipe from the left edge, or the topbar's menu button), with the same
// lists/tags/Show All content as its drawerContent. LinksPageProvider wraps the
// NAVIGATOR (not the screen) because the drawer content needs the same
// selection context the screen reads — it highlights the active row and
// commits selections via setSimpleQuery.
//
// The drawer's swipe gesture is why GestureHandlerRootView wraps the root
// layout (src/app/_layout.tsx).
//
// On a WIDE window the same Drawer is `permanent` — docked beside the list,
// the expo form of web's two-pane frame — unless the user put it away
// (features/links/sidebar-rail.tsx owns that state, and the provider wraps the
// navigator for the reason LinksPageProvider does: the drawer content and the
// screen both read it). `drawerStyle` for the docked rail sets its width — the
// user's step for this window's shape, or the step a drag on its edge is over,
// dimmed over the collapse zone — and takes back the hairline react-navigation
// draws on a permanent drawer in the stock theme's fixed light grey: the Sidebar
// draws its own `border-r` in the token (see its root), and two edges would show
// in dark. The edge's grip (RailWidthHandle) is drawn over the Drawer rather than
// in it, so it can sit across the rail's edge, and only while docked, since the
// overlay drawer has no width to step. Inside SheetCovered, so a sheet covers it.
//
// LiveReadPause stops the section's live reads while another screen covers it
// (features/links/use-paused-while-covered.ts), so a write made from Settings
// doesn't re-render a links screen nobody can see. It is OUTSIDE
// LinksPageProvider on purpose: that provider holds live reads of its own
// (useLists, useTags, useSettings), and a pause mounted under it would leave
// them running. The hook is called here for the matching reason — outside the
// Drawer, `useNavigation()` is the (app) stack's, whose events say when this
// route is covered.
//
// SheetHost wraps the Drawer rather than living in the screen, so a sheet — the
// add panel, the link editor, Advanced Search (components/ui/sheet.tsx) — spans
// the docked rail too. The three hosts inside it own those sheets' open state
// and draw each sheet as a sibling AFTER the covered Drawer
// (features/links/link-add-host.tsx, link-edit-host.tsx, search-bar.tsx); all
// sit inside LinksPageProvider because the bodies read the viewing list and the
// query.
export default function LinksLayout() {
  const paused = usePausedWhileCovered();
  return (
    <LiveReadPause paused={paused}>
      <LinksPageProvider>
        <SidebarRailProvider>
          <SheetHost>
            <LinkAddHost>
              <LinkEditHost>
                <AdvancedSearchHost>
                  <SheetCovered>
                    <LinksDrawer />
                  </SheetCovered>
                </AdvancedSearchHost>
              </LinkEditHost>
            </LinkAddHost>
          </SheetHost>
        </SidebarRailProvider>
      </LinksPageProvider>
    </LiveReadPause>
  );
}

function LinksDrawer() {
  const { docked, width, dragTarget } = useSidebarRail();
  return (
    <>
      <Drawer
        drawerContent={(props) => (
          <Sidebar
            closeDrawer={() => props.navigation.closeDrawer()}
            headerAction={docked ? <HideRailButton /> : undefined}
          />
        )}
        screenOptions={{
          headerShown: false,
          drawerType: docked ? 'permanent' : 'front',
          drawerStyle: docked
            ? { width, borderRightWidth: 0, opacity: dragTarget === 'collapse' ? 0.5 : 1 }
            : undefined,
        }}
      />
      {docked && <RailWidthHandle />}
    </>
  );
}
