import { useState } from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

import { SyncPausedNotice } from '../../../components/sync-paused-notice';
import { AddLinkFab } from '../../../features/links/add-link-fab';
import { BulkTagsDialog } from '../../../features/links/bulk-tags-dialog';
import { LinkAddPanel } from '../../../features/links/link-add-panel';
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
// `adding` is the add panel's open state, and it lives HERE rather than in
// LinksViewStateProvider for two reasons: this component has to read it (the
// a11y hide below is on the body it renders, and a provider's own parent cannot
// consume it), and — unlike `destroying`/`retagging` — it is not an engagement
// signal. Web doesn't count its add surface in `engaged` either: nothing under
// this panel is row-anchored, and a repaint below a full-screen dim disturbs
// nothing. Mounting it only while open is also what keeps the draft ephemeral
// (link-add-panel.tsx) and what lets its exit animation run.
export default function LinksScreen() {
  const [adding, setAdding] = useState(false);

  return (
    <LinksViewStateProvider>
      {/* `links-screen` is what every Maestro flow waits on to know a sign-in
          landed — the root marker of docs/e2e.md's testID contract. It sits on
          the screen root rather than on any of the panes below because those
          swap (LockPane, EmptyState) while this is what "signed in and home"
          means. */}
      {/* The covered body opts out of the accessibility tree while the panel is
          up, so a screen reader can't walk out of the form into the list behind
          it. iOS is covered twice over — `accessibilityElementsHidden` here and
          `accessibilityViewIsModal` on the panel — and MEASURED to work.
          Android's half does NOT work: neither prop (nor `aria-hidden`, with or
          without `collapsable={false}`) removes anything from the tree under RN
          0.81/Fabric, verified against a hardcoded flag and read back through
          both `maestro hierarchy` and `uiautomator dump`. It is kept because it
          is the correct spelling and costs nothing, and because every portaled
          Dialog in this app has the same gap today — docs/accessibility.md,
          _modality_, carries the measurement. */}
      <StyledSafeAreaView testID="links-screen" className="flex-1 bg-background">
        <View
          importantForAccessibility={adding ? 'no-hide-descendants' : 'auto'}
          accessibilityElementsHidden={adding}
          collapsable={false}
          className="min-h-0 flex-1"
        >
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
          <AddLinkFab onPress={() => setAdding(true)} />
        </View>
      </StyledSafeAreaView>
      <BulkTagsDialog />
      <LinkDestroyConfirm />
      {/* Last sibling, and outside the SafeAreaView: it is an absolute layer over
          the whole screen box, so it must not inherit the body's insets — and
          being last is what puts it above the FAB it was summoned from. */}
      {adding && <LinkAddPanel onClose={() => setAdding(false)} />}
    </LinksViewStateProvider>
  );
}
