import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

import { RenderMeasureControls } from '../../../components/measure-probe';
import { SyncPausedNotice } from '../../../components/sync-paused-notice';
import { AddLinkFab } from '../../../features/links/add-link-fab';
import { BulkTagsDialog } from '../../../features/links/bulk-tags-dialog';
import { useLinkAdd } from '../../../features/links/link-add-host';
import { LinkDestroyConfirm } from '../../../features/links/link-destroy-confirm';
import { Main } from '../../../features/links/main';
import { PreviewsPrompt } from '../../../features/links/previews-prompt';
import { SearchBar } from '../../../features/links/search-bar';
import { Topbar } from '../../../features/links/topbar';
import { LinksViewStateProvider } from '../../../features/links/view-state-provider';

const StyledSafeAreaView = withUniwind(SafeAreaView);

// `/links` — the home of the signed-in app, mirroring bracemark-web's
// `(app)/links/page.tsx` composition: the topbar above the scrolling main
// pane, wrapped in LinksViewStateProvider (the topbar's search toggle and the
// ⋯ menu's bulk-edit entry write the view state the bar row and main pane
// read). SearchBar renders null until summoned (searchOpen, or force-shown by
// a committed search — see topbar's `searchVisible`), so it mounts
// unconditionally here — as do the two screen-level dialogs the bulk-edit bar
// requests through view state (`retagging`/`destroying`; hoisted so a list
// repaint can't unmount them mid-edit — web's rationale). The bulk-edit bar
// itself is rendered by Main, which owns the `links` it acts on. The sidebar
// half of web's frame is the Drawer in this group's _layout, where
// LinksPageProvider also lives (the drawer content shares it). Thin by
// convention — the UI is in src/features/links/.
//
// The add panel is NOT rendered here: the FAB asks LinkAddHost
// (features/links/link-add-host.tsx), which `_layout.tsx` wraps around the
// Drawer so the panel's layer covers the docked rail as well as this screen.
// Its open state is still not view state — unlike `destroying`/`retagging` it
// is not an engagement signal; web doesn't count its add surface in `engaged`
// either: nothing under the panel is row-anchored, and a repaint below a
// full-screen dim disturbs nothing.
export default function LinksScreen() {
  const { openAdd } = useLinkAdd();

  return (
    <LinksViewStateProvider>
      {/* `links-screen` is what every Maestro flow waits on to know a sign-in
          landed — the root marker of docs/e2e.md's testID contract. It sits on
          the screen root rather than on any of the panes below because those
          swap (LockPane, EmptyState) while this is what "signed in and home"
          means. */}
      <StyledSafeAreaView testID="links-screen" className="flex-1 bg-background">
        {/* The body box the FAB is positioned in: `absolute` resolves against
            the parent's padding box, so on the SafeAreaView itself `bottom-4`
            would measure from inside the home-indicator inset. */}
        <View className="min-h-0 flex-1">
          <Topbar />
          <SearchBar />
          {/* The first-run link-previews offer — renders null unless the opt-in
              is off, undismissed, AND links are actually waiting, and never over
              a locked list (see the component). Above Main so it reads as
              chrome, not a list item. */}
          {/* Sync paused — the expired session's notice (docs/sessions.md);
              null unless the server asked for a sign-in. Above the previews
              offer, as on web. */}
          <SyncPausedNotice />
          <PreviewsPrompt />
          <Main />
          {/* Screen-level, not in Main: the add affordance survives Main's
              LockPane/EmptyState swaps (web's topbar Add is always there). */}
          <AddLinkFab onPress={openAdd} />
          {/* Measurement bundles only (the render leg's window controls);
              nothing in any other build. */}
          <RenderMeasureControls />
        </View>
      </StyledSafeAreaView>
      <BulkTagsDialog />
      <LinkDestroyConfirm />
    </LinksViewStateProvider>
  );
}
