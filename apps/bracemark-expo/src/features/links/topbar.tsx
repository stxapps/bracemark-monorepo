// The bar above the links list — the expo port of bracemark-web's
// `(app)/links/_panes/topbar.tsx`: the active selection's name (what the main
// pane is showing) plus the screen's chrome actions. On mobile the leading
// action is the drawer toggle (web's sidebar is always visible) and the
// trailing pair is the search toggle — web's persistent search box doesn't fit
// a phone topbar, so it summons the SearchBar row below (view-state-provider
// `searchOpen`) — and the ⋯ overflow menu (more-options-menu.tsx), which
// absorbed the old direct Settings button. Web's remaining actions live
// elsewhere on this screen: add is the FAB over the list (add-link-fab.tsx —
// no topbar slot), bulk edit is the ⋯ menu's "Select links" (with its
// bottom-anchored toolbar). Sync lives in the ⋯ menu AND
// as the list's pull-to-refresh — the gesture is the platform idiom, the menu
// entry carries the error/retry affordance.

import { useCallback, useEffect } from 'react';
import { BackHandler, View } from 'react-native';
import { DrawerActions } from '@react-navigation/native';
import { useNavigation } from 'expo-router';
import { Menu, Search } from 'lucide-react-native';

import { useLists, useTags } from '@stxapps/expo-react';
import { ALL_LABEL, flattenTree } from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { MoreOptionsMenu } from './more-options-menu';
import { useLinksPage } from './page-provider';
import { useLinksViewState } from './view-state-provider';

function useSelectionLabel(): string {
  const { selection } = useLinksPage();
  const lists = useLists();
  const tags = useTags();

  if (selection.kind === 'all') return ALL_LABEL;
  // A text search or compound/multi filter has no single-axis name — title the
  // view generically rather than borrowing a stale list/tag name.
  if (selection.kind === 'none') return 'Search';
  // POSITIVE EVIDENCE ONLY, the same rule page-provider's isStaleSelection runs
  // on: useLists/useTags collapse "still loading" into `[]` (docs/search.md), so
  // an empty tree proves nothing about an id and must name nothing. Convicting
  // one off it put the word "Unknown" in the title on EVERY cold mount — the
  // default inbox included — for as long as the first read took, which is the
  // dead end the stale-selection redirect exists to prevent, arriving as a
  // flash instead. Blank until the tree can either name the id or convict it.
  if (selection.kind === 'list') {
    // Look the name up in the merged list tree — so a renamed system list shows
    // its override name, not the code default. Flatten since the match may be
    // at any depth.
    const nodes = flattenTree(lists);
    if (nodes.length === 0) return '';
    return nodes.find((n) => n.item.id === selection.id)?.item.name ?? 'Unknown';
  }
  const nodes = flattenTree(tags);
  if (nodes.length === 0) return '';
  return nodes.find((n) => n.item.id === selection.id)?.item.name ?? 'Unknown';
}

export function Topbar() {
  const label = useSelectionLabel();
  const navigation = useNavigation();
  const { searchVisible, setSearchOpen, restorePreSearch } = useLinksViewState();

  // Closing DISMISSES the search: with the bar gone, a committed search
  // ('none' selection) would keep filtering the list with no visible surface
  // left to show or clear it — so `restorePreSearch` returns to where the
  // search began, or home if nothing simple has been seen yet. A plain list/tag
  // view (nothing committed, or a single-list/tag advanced search) just hides
  // the bar and stays put, which is that call's own no-op branch. The bar's ✕
  // and an emptied box (search-bar.tsx) run the same body, so no exit lands
  // somewhere different from another.
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    restorePreSearch();
  }, [restorePreSearch, setSearchOpen]);

  // Android back closes the search UI before it navigates — the platform
  // cascade (keyboard → search → navigation; the IME consumes the first press
  // itself). Registered only while the bar shows, so back keeps its navigation
  // meaning on a plain view — and re-registering on open puts this handler
  // ahead of the navigator's own (BackHandler runs listeners newest-first).
  // Inert on iOS: hardwareBackPress never fires there, and the swipe-back
  // gesture deliberately stays navigation.
  useEffect(() => {
    if (!searchVisible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeSearch();
      return true; // consumed — don't navigate
    });
    return () => sub.remove();
  }, [searchVisible, closeSearch]);

  const toggleSearch = () => {
    if (!searchVisible) {
      setSearchOpen(true);
      return;
    }
    closeSearch();
  };

  return (
    <View className="h-14 shrink-0 flex-row items-center gap-2 border-b border-border px-3">
      {/* hitSlop, on this and every other chrome button in the app: the boxes
          are 36, under both platform floors (iOS HIG 44pt, Material 48dp), and
          growing them would mean re-cutting both topbars — the bar is h-14, so
          6px each way reaches 48 with room to spare and costs no layout at all.
          The one rule: never take more than HALF the gap to a pressable
          neighbour, since RN resolves overlapping touch regions by tree order
          (the later sibling wins) and the loser's own visible box is what gets
          eaten. Nothing pressable sits beside this one — the title is a Text —
          so it takes the full 6. */}
      <Button
        variant="ghost"
        size="icon-sm"
        testID="links-open-navigation"
        onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
        aria-label="Open navigation"
        hitSlop={6}
        className="-ml-1"
      >
        <Icon as={Menu} className="size-5 text-foreground" />
      </Button>
      {/* THE TITLE IS THE VIEW'S NAME AND CARRIES THE WEIGHT — the opposite of
          the settings topbar's, whose label is a surface marker over a pane that
          has its own heading. Here there is no heading below: the list starts
          immediately, so this line is the only thing that says which of a
          hundred lists you are looking at, and it stays `text-lg font-semibold`
          for it. The drawer button and the two actions match the settings bar
          exactly (`size-9`, pulled to the frame edge, `px-3` row) — a user
          crosses between the two bars constantly and they must not shift.

          THE GLYPHS ARE `size-5` (20) WHERE WEB'S ARE `size-4` (16), and that
          divergence is deliberate, not drift: 16 is the desktop grid web's
          topbar comment pins itself to, while a phone's navigation chrome sits
          nearer the platform norms (iOS nav-bar symbols ~22pt, Material's top
          app bar 24dp). Both apps otherwise run on `size-4` — 20 is the
          exception on each, applied here to all nav chrome and on web only to
          MoreHorizontal.

          What the two platforms DO hold in common is the number that matters,
          which is neither the box nor the glyph but the free margin between
          them — because that gap is what a corner dot has to live in. Web's
          search trigger is 36/16 and this app's is 40/20: both leave exactly
          10px a side. Both ⋯ triggers are 36/20, both leave 8 — which is why
          that one's dot comment argues about 4px vs 5px at all. Change a glyph
          rung without re-deriving the box and the dot is what breaks, silently
          (search-bar.tsx spells out the arithmetic for its own trigger). */}
      <Text numberOfLines={1} className="min-w-0 flex-1 text-lg font-semibold">
        {label}
      </Text>
      <View className="flex-row items-center gap-1">
        <Button
          variant={searchVisible ? 'secondary' : 'ghost'}
          size="icon-sm"
          onPress={toggleSearch}
          // The name states what pressing it DOES, which keeps every state
          // collision-free: closed it is the only "Search links" on screen; open,
          // the box below owns that name and this becomes "Close search" — honest,
          // since dismissing a committed search also restores the view it ran from.
          aria-label={searchVisible ? 'Close search' : 'Search links'}
          aria-expanded={searchVisible}
          // `right: 2` is half the `gap-1` to the ⋯ trigger — see the drawer
          // button's note. Left is free (the title Text takes no touches).
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 2 }}
        >
          {/* Constant `text-foreground`, like every other icon button on this
              bar and like web's: the open state is already carried by the
              `secondary` variant above — the same spelling web uses, and the
              same fill, since `--secondary` and `--muted` are one value in both
              themes — and dimming the glyph on top of it made the
              INACTIVE state look disabled rather than the active one look
              picked. */}
          <Icon as={Search} className="size-5 text-foreground" />
        </Button>
        <MoreOptionsMenu />
      </View>
    </View>
  );
}
