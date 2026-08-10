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
import { BackHandler, Pressable, View } from 'react-native';
import { DrawerActions } from '@react-navigation/native';
import { useNavigation } from 'expo-router';
import { Menu, Search } from 'lucide-react-native';

import { useLists, useTags } from '@stxapps/expo-react';
import { ALL_LABEL, DEFAULT_LIST_ID, flattenTree } from '@stxapps/shared';

import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { MoreOptionsMenu } from './more-options-menu';
import { useLinksPage } from './page-provider';
import { type SimpleSelection, useLinksViewState } from './view-state-provider';

// Where a dismissed search lands when there's no `preSearch` snapshot to
// restore — the default inbox (serializes to the bare `/links`).
const HOME_SELECTION: SimpleSelection = { kind: 'list', id: DEFAULT_LIST_ID };

function useSelectionLabel(): string {
  const { selection } = useLinksPage();
  const lists = useLists();
  const tags = useTags();

  if (selection.kind === 'all') return ALL_LABEL;
  // A text search or compound/multi filter has no single-axis name — title the
  // view generically rather than borrowing a stale list/tag name.
  if (selection.kind === 'none') return 'Search';
  if (selection.kind === 'list') {
    // Look the name up in the merged list tree — so a renamed system list shows
    // its override name, not the code default. Flatten since the match may be
    // at any depth.
    return flattenTree(lists).find((n) => n.item.id === selection.id)?.item.name ?? 'Unknown';
  }
  return flattenTree(tags).find((n) => n.item.id === selection.id)?.item.name ?? 'Unknown';
}

export function Topbar() {
  const label = useSelectionLabel();
  const navigation = useNavigation();
  const { selection, setSimpleQuery } = useLinksPage();
  const { searchVisible, setSearchOpen, preSearch, setPreSearch } = useLinksViewState();

  // Closing DISMISSES the search: with the bar gone, a committed search
  // ('none' selection) would keep filtering the list with no visible surface
  // left to show or clear it — return to where the search began, or home if
  // there's no snapshot. Both targets are `SimpleSelection`s, so neither can
  // resolve back to 'none' and force the bar open again. A plain list/tag
  // view (nothing committed, or a single-list/tag advanced search) just
  // hides the bar and stays put. The two close paths — the toggle and the
  // Android back press below — share this one body so the restore semantics
  // can't drift.
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    if (selection.kind === 'none') setSimpleQuery(preSearch ?? HOME_SELECTION);
  }, [selection, setSimpleQuery, preSearch, setSearchOpen]);

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
      // Snapshot where the user is, so dismissing a committed search returns
      // here. Always simple in this branch — a 'none' selection forces the bar
      // visible, so opening can't happen under one; the explicit guard is what
      // proves that to TS now that `searchVisible` comes from context (it can no
      // longer narrow `selection` through a local alias).
      if (selection.kind !== 'none') setPreSearch(selection);
      setSearchOpen(true);
      return;
    }
    closeSearch();
  };

  return (
    <View className="h-14 shrink-0 flex-row items-center gap-2 border-b border-border px-3">
      <Pressable
        onPress={() => navigation.dispatch(DrawerActions.openDrawer())}
        aria-label="Open navigation"
        className="-ml-1 size-9 items-center justify-center rounded-md active:bg-muted"
      >
        <Icon as={Menu} className="size-5 text-foreground" />
      </Pressable>
      {/* THE TITLE IS THE VIEW'S NAME AND CARRIES THE WEIGHT — the opposite of
          the settings topbar's, whose label is a surface marker over a pane that
          has its own heading. Here there is no heading below: the list starts
          immediately, so this line is the only thing that says which of a
          hundred lists you are looking at, and it stays `text-lg font-semibold`
          for it. The drawer button and the two actions match the settings bar
          exactly (`size-9`, pulled to the frame edge, `px-3` row) — a user
          crosses between the two bars constantly and they must not shift. */}
      <Text numberOfLines={1} className="min-w-0 flex-1 text-lg font-semibold">
        {label}
      </Text>
      <View className="flex-row items-center gap-1">
        <Pressable
          onPress={toggleSearch}
          // The name states what pressing it DOES, which keeps every state
          // collision-free: closed it is the only "Search links" on screen; open,
          // the box below owns that name and this becomes "Close search" — honest,
          // since dismissing a committed search also restores the view it ran from.
          aria-label={searchVisible ? 'Close search' : 'Search links'}
          aria-expanded={searchVisible}
          className={cn(
            'size-9 items-center justify-center rounded-md active:bg-muted',
            searchVisible && 'bg-muted',
          )}
        >
          <Icon
            as={Search}
            className={cn('size-5', searchVisible ? 'text-foreground' : 'text-muted-foreground')}
          />
        </Pressable>
        <MoreOptionsMenu />
      </View>
    </View>
  );
}
