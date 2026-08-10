import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

import { AddLinkFab } from '../../../features/links/add-link-fab';
import { BulkTagsDialog } from '../../../features/links/bulk-tags-dialog';
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
export default function LinksScreen() {
  return (
    <LinksViewStateProvider>
      <StyledSafeAreaView className="flex-1 bg-background">
        <View className="min-h-0 flex-1">
          <Topbar />
          <SearchBar />
          {/* The first-run link-previews offer — renders null unless the opt-in
              is off, undismissed, AND links are actually waiting (see the
              component). Above Main so it reads as chrome, not a list item. */}
          <PreviewsPrompt />
          <Main />
          {/* Screen-level, not in Main: the add affordance survives Main's
              LockPane/EmptyState swaps (web's topbar Add is always there). */}
          <AddLinkFab />
        </View>
      </StyledSafeAreaView>
      <BulkTagsDialog />
      <LinkDestroyConfirm />
    </LinksViewStateProvider>
  );
}
