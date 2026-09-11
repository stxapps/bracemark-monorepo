// The main pane: reads the paginated link query and renders it as a FlashList
// — the expo port of bracemark-web's `(app)/links/_panes/main.tsx` PLUS its layout
// switch. Web mounts a whole layout component per `linksLayout` value because
// each owns its own virtualizer wiring (card-layout chunks links into rows of N
// for the 1D virtualizer); FlashList makes the grid native — `numColumns`,
// flat item indexes, onEndReached untouched — so here a layout is per-ITEM
// config (LAYOUTS below: item renderer + column math) and the scroll chrome
// (refresh pill, pull-to-refresh, infinite scroll, bulk-edit bar) is written
// once. The item anatomy lives in link-row.tsx / link-card.tsx; the pieces they
// share in shared.tsx. Other divergences from web:
//
//  - Virtualization is FlashList's own; infinite scroll is onEndReached
//    (web's virtual-index effect) — no ShowMore fallback button needed, the
//    reached-end callback is the platform contract.
//  - Pull-to-refresh triggers a sync cycle (web's overflow-menu Sync entry) —
//    the mobile idiom; it also applies any held results, since the gesture is
//    the user asking for fresh content at the top.
//  - Items carry the preview image and the site favicon (link-media.tsx —
//    both local-first, fetched on demand as items mount; the favicon by direct
//    native fetch under the extraction opt-in, with the monogram as the
//    steady-state fallback).
//  - An item press opens the URL in the system browser (web's anchor) — except
//    in bulk-edit mode (view-state `bulkEditing`), where items grow a checkbox
//    and a press toggles selection instead (web's selectable rows).
//    The mode's chrome is the bottom-anchored BulkEditBar, rendered HERE (not
//    the screen) because it needs this pane's `links` for Select all and
//    display-order Copy — the same reason web's Main passes its useLinks result
//    to the toolbar. Pull-to-refresh is suspended while the mode is on (its
//    applyPending would repaint items under the selection).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  FlashList,
  type FlashListRef,
  type ListRenderItemInfo,
  type ViewToken,
} from '@shopify/flash-list';

import { type LinkView, useExtraction, useLocks, useSettings, useSync } from '@stxapps/expo-react';
import { LOCK_COPY } from '@stxapps/react';
import { type LinkSortOn } from '@stxapps/shared';

import { LockPane } from '../../components/lock-pane';
import { BulkEditBar } from './bulk-edit-bar';
import { CARD_H_CHROME, LinkCard } from './link-card';
import { hasKnownTags, LinkRow } from './link-row';
import { useLinksPage } from './page-provider';
import { EmptyState, type LinkItemProps, RefreshPill, useTagMap } from './shared';
import { useLinks } from './use-links';
import { useLinksViewActions, useLinksViewState } from './view-state-provider';

// Past this many pixels we treat the pane as "scrolled away from the top", so a
// background sync is staged behind the refresh pill (see view-state-provider).
const SCROLL_TOP_THRESHOLD = 8;

// Which rows count as "displayed" for the extraction drain (web's virtualizer
// window, in FlashList terms): ANY sliver on screen counts (threshold 0 — a
// half-visible row is one the user is about to read), but only after it has
// stayed there briefly, so a fast fling past 400 rows doesn't queue every one of
// them. The drain re-scans this set each step, so a row scrolled away mid-step
// simply stops being picked.
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 0, minimumViewTime: 250 };

// The smallest a CARD may get before the card grid drops a column — web's
// MIN_CARD_WIDTH (card-layout.tsx), the same 300 rather than a mobile-scaled
// number. The card's meta line is a favicon, the host, the badges and the ⋯
// menu on one text-base line, and the host is the line that says where the link
// goes: at two columns on a 390pt phone the card is 187 wide and the host gets
// ~103 of it, about 13 characters, so `www.nytimes.com` truncates. One column
// there gives it ~274. So the grid is one column on every phone (two needs
// 648pt of outer width) and 2–4 on a tablet — which is where web lands at those
// same widths, a 390px browser window included.
const MIN_CARD_WIDTH = 300;
// The pane's content padding in card layout: pairs with each card's own p-2
// (link-card.tsx) so edges and inter-card gaps both come to 16 — web's p-4
// container + gap-4 grid.
const CARD_GRID_PADDING = 8;

type LayoutConfig = {
  // FlashList's remount key on a layout switch (below) — the RESOLVED layout,
  // not the raw setting string, so unknown synced values don't churn the list.
  // It doubles as the skeleton's shape (shared.tsx): the first-read silhouette
  // has to be the shape of whatever is about to land, and this is the only place
  // that knows which layout resolved.
  name: 'list' | 'card';
  Item: (props: LinkItemProps) => React.ReactNode;
  // This layout's FlashList recycle pools: a view is only ever reused for an
  // item of the same type, so it rarely has to change SHAPE on recycle. Both
  // layouts have two — a tagged item carries a chip strip and is a chip line
  // taller than a bare one — and without this they share one pool, so a scroll
  // makes every mismatched reuse re-lay out and re-measure the cell. The card
  // pays MORE for a mismatch than the row does: its cells are height-normalized
  // per grid row (link-card.tsx), so one re-measured cell can re-lay out the
  // whole row it landed in. Tag-ness is all this can key on: the other height
  // input is whether the title wraps to its second line, which isn't knowable
  // without laying the text out, so a one-line and a two-line item of the same
  // tag-ness do still share a pool. Called very often (FlashList's own note),
  // hence a Map lookup and no allocation.
  itemType?: (link: LinkView, tagsById: Map<string, string>) => string;
  columns: (paneWidth: number) => number;
  contentPadding: number;
};

const LIST_LAYOUT: LayoutConfig = {
  name: 'list',
  Item: LinkRow,
  itemType: (link, tagsById) => (hasKnownTags(link, tagsById) ? 'tagged' : 'bare'),
  columns: () => 1,
  contentPadding: 0,
};
const CARD_LAYOUT: LayoutConfig = {
  name: 'card',
  Item: LinkCard,
  itemType: (link, tagsById) => (hasKnownTags(link, tagsById) ? 'tagged' : 'bare'),
  // Web's fit math, in this platform's cell model. Web adds its 16pt gutter
  // BETWEEN cells (`gap-4`, hence its `+ CARD_GAP` term); here the gutter rides
  // inside every cell as the card's own p-2 (CARD_H_CHROME), so it belongs in
  // the divisor instead. Both spellings reduce to n cards of 300 with 16 between
  // and 16 outside, so the two platforms drop to one column at the same outer
  // width — 648 — rather than merely near each other.
  columns: (paneWidth) => Math.max(1, Math.floor(paneWidth / (MIN_CARD_WIDTH + CARD_H_CHROME))),
  contentPadding: CARD_GRID_PADDING,
};

// Keyed by the persisted `linksLayout` string with a `| undefined` value — web
// main.tsx's rationale: the setting is SYNCED, so a device on a newer client
// can store a layout this build doesn't implement, and the lookup can miss.
// UnlockedMain falls back to the dense default WITHOUT writing the fallback
// back, so the stored value still applies on the device that chose it.
const LAYOUTS: Record<string, LayoutConfig | undefined> = {
  list: LIST_LAYOUT,
  card: CARD_LAYOUT,
};

// The FlashList `extraData` — everything renderItem reads beyond the item
// itself (UnlockedMain's itemExtra carries the why).
type ItemExtra = {
  links: readonly LinkView[];
  pinnedCount: number;
  bulkEditing: boolean;
  selectedLinks: ReadonlyMap<string, LinkView>;
  toggleSelected: (link: LinkView) => void;
  tagsById: Map<string, string>;
  sortOn: LinkSortOn;
  itemWidth: number;
};

export function Main() {
  const { selection } = useLinksPage();
  const { isListLocked, unlockList, biometricForList, biometricLabel, unlockListWithBiometric } =
    useLocks();

  // The main pane's body while the selected list is locked — a SWAP for the
  // list, not an overlay (web main.tsx's rationale): UnlockedMain (and its
  // link query) simply doesn't mount, so the locked links are never fetched.
  // Unlocking flips lock-provider's in-memory state and the list mounts fresh.
  if (selection.kind === 'list' && isListLocked(selection.id)) {
    const listId = selection.id;
    return (
      <View className="min-h-0 flex-1">
        <LockPane
          className="flex-1"
          title={LOCK_COPY.list.title}
          description={LOCK_COPY.list.description}
          onUnlock={(password) => unlockList(listId, password)}
          biometric={
            biometricForList(listId)
              ? { label: biometricLabel, onUnlock: () => unlockListWithBiometric(listId) }
              : undefined
          }
        />
      </View>
    );
  }

  return <UnlockedMain />;
}

function UnlockedMain() {
  // The resolved sort is intrinsic to the query (page-provider), so read it off
  // the same context the reads run through and hand it to the date column.
  const { query } = useLinksPage();
  const { linksLayout } = useSettings();
  const { links, pinnedCount, hasMore, showMore, isLoading, hasPending, applyPending } = useLinks();
  const { bulkEditing, selectedLinks } = useLinksViewState();
  const { setScrolled, toggleSelected } = useLinksViewActions();
  const { bgSyncStatus, requestSync } = useSync();
  const tagsById = useTagMap();
  const listRef = useRef<FlashListRef<LinkView>>(null);

  // Feed the extraction drain the rows actually on screen, so automatic preview
  // work tracks ATTENTION — a 30k-link import never extracts past what was
  // scrolled into view (extraction-provider, cost layer 2).
  //
  // FlashList wires viewability once, when the list is constructed: whether an
  // `onViewableItemsChanged` exists at all, and `viewabilityConfig` (its own
  // docs: "changing viewabilityConfig on the fly is not supported" — hence the
  // module constant). The callback's IDENTITY is not captured: v2 calls it
  // through its current props, so the "Changing onViewableItemsChanged on the
  // fly" throw is React Native FlatList's (and FlashList v1's), not this list's.
  // The `[]`-dep callback reading the reporter through a ref is therefore not
  // load-bearing — it keeps one function for the list's lifetime, and the
  // unmount cleanup below reads the same ref.
  const { reportDisplayedLinkPaths } = useExtraction();
  const reportRef = useRef(reportDisplayedLinkPaths);
  reportRef.current = reportDisplayedLinkPaths;
  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<LinkView>[] }) => {
      // `item` is typed non-null but FlashList can hand back a recycled token
      // mid-update, so the path is filtered rather than asserted.
      reportRef.current(
        viewableItems
          .map((token) => token.item?.path)
          .filter((path): path is string => typeof path === 'string'),
      );
    },
    [],
  );
  // The pane owns this report while it's mounted; clear it on unmount so a
  // navigation away (or the lock swap) doesn't leave the drain working a page
  // nobody is looking at.
  useEffect(() => () => reportRef.current([]), []);

  const { name, Item, itemType, columns, contentPadding } = LAYOUTS[linksLayout] ?? LIST_LAYOUT;
  // Window width MINUS what the pane doesn't get, rather than a measured
  // container: the window value is available synchronously, so there's no
  // DEFAULT_COLUMNS flash to paper over (web's useElementWidth dance isn't
  // needed here). Two subtractions keep it honest — the screen's horizontal
  // safe-area insets (the screen wraps this in an all-edges SafeAreaView; they
  // are 0 in portrait, but the column math shouldn't silently depend on
  // app.config.ts's orientation lock) and the grid's own content padding, which
  // is inside the list and so is space no column can use. Feed the raw window
  // width instead and MIN_CARD_WIDTH stops being the guarantee it exists to be.
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const paneWidth = width - insets.left - insets.right - contentPadding * 2;
  const numColumns = columns(paneWidth);
  // One cell's width, for the item's own internal budgets — today just the tag
  // strip's, which estimates how many chips fit rather than measuring (see
  // link-tag-chips.tsx for why measuring is the wrong trade in a recycling
  // list). Derived here because this is where the column math already lives.
  const itemWidth = paneWidth / numColumns;

  // Everything an item renders from beyond its own `link`, and so the ONLY
  // thing that re-renders mounted items. A cell (FlashList v2's ViewHolder, a
  // React.memo) re-renders when its item, index or layout moves, or when
  // `extraData` or `renderItem` changes identity. renderItem below is stable and
  // reads nothing but this object, so the pane's own renders — a scroll-flag
  // flip, a menu opening (`engaged`, via useLinks), an extraction or sync status
  // change — no longer reach the items; only a change in here does: a selection
  // toggle (new map identity), a tag rename (tagsById — renames must repaint
  // immediately, see useTagMap), a sort change (the row's date column), a
  // rotation (itemWidth, the tag strip's budget). Even then only the items whose
  // own props moved render: every cell re-runs renderItem, but the items are
  // React.memo (LinkItemProps' header), so a selection tap renders the one item
  // it toggled.
  //
  // The rule that keeps that correct: renderItem may read ONLY from here. A
  // value it closed over instead would go stale in already-mounted cells.
  //
  // `links` rides along for the index-derived props (pinned, isFirst, isLast).
  // The ViewHolder skips renderItem when only an item's INDEX moves (its
  // children memo leaves index out), so a pin reorder would leave those stale
  // if nothing in here changed with it. Today's reads build fresh LinkView
  // objects anyway, so a new `links` already means every item changed and this
  // costs nothing; it's here so a later structural-sharing read can't break it.
  const itemExtra = useMemo<ItemExtra>(
    () => ({
      links,
      pinnedCount,
      bulkEditing,
      selectedLinks,
      toggleSelected,
      tagsById,
      sortOn: query.sortOn,
      itemWidth,
    }),
    [
      links,
      pinnedCount,
      bulkEditing,
      selectedLinks,
      toggleSelected,
      tagsById,
      query.sortOn,
      itemWidth,
    ],
  );
  // `Item` changes only on a layout switch, which remounts the list anyway
  // (the FlashList `key`).
  const renderItem = useCallback(
    ({ item, index, extraData }: ListRenderItemInfo<LinkView>) => {
      const x = extraData as ItemExtra;
      return (
        <Item
          link={item}
          pinned={index < x.pinnedCount}
          // The pinned section's ends, for the row menu's Move up/down
          // (meaningful only when pinned; pins sort first, so flat indexes
          // 0..pinnedCount-1 are exactly the pinned section).
          isFirst={index === 0}
          isLast={index === x.pinnedCount - 1}
          sortOn={x.sortOn}
          tagsById={x.tagsById}
          itemWidth={x.itemWidth}
          selectMode={x.bulkEditing}
          selected={x.selectedLinks.has(item.path)}
          // Unwrapped, so the memo'd item sees the same function every render
          // (LinkItemProps' header).
          onToggle={x.toggleSelected}
        />
      );
    },
    [Item],
  );

  // Pull-to-refresh: the spinner is OUR gesture's, so it's local state armed on
  // pull and released when the cycle it kicked settles — binding it straight to
  // bgSyncStatus would spin it for background cycles the user never pulled for.
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (bgSyncStatus !== 'syncing') setRefreshing(false);
  }, [bgSyncStatus]);

  // This pane owns the scroll position; reset the shared flag on mount/unmount
  // so a stale `scrolled` can't pin `engaged` (web's layout effect, verbatim).
  useEffect(() => {
    setScrolled(false);
    return () => setScrolled(false);
  }, [setScrolled]);

  // ...and put the list back at the top whenever the VIEW changes. This pane
  // stays mounted across a drawer pick, a committed search or a sort change, so
  // without this the FlashList keeps the offset the previous view left. And
  // since `useLinks` resets `limit` to PAGE_SIZE on the same change, the new view
  // is at most one page tall against an offset that may have come from a far
  // deeper one: past the new content height it clamps, landing the user at the
  // BOTTOM of a list they never scrolled, where onEndReached pages it further.
  //
  // Keyed on the `query` IDENTITY (page-provider memoizes it per view), not on
  // `selection` — the lossy single-axis projection holds still across two
  // different searches and doesn't move for a sort change, which reorders every
  // row. The same trigger use-links resets `limit` on. Web spells this as a
  // shared hook because it has one scroller PER LAYOUT (_layouts/shared/hooks.ts,
  // the canonical note); FlashList makes the grid native, so this pane has one
  // list ref for both layouts and the effect belongs here.
  //
  // `setScrolled(false)` rides along for the same reason the mount effect above
  // resets it. While the view is empty the FlashList is unmounted behind
  // EmptyState, so the ref is null and the call no-ops — it re-mounts at 0.
  const prevQueryRef = useRef(query);
  useEffect(() => {
    if (prevQueryRef.current === query) return;
    prevQueryRef.current = query;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    setScrolled(false);
  }, [query, setScrolled]);

  const applyAndScrollTop = () => {
    applyPending();
    listRef.current?.scrollToOffset({ offset: 0 });
  };

  return (
    <>
      {links.length === 0 ? (
        <EmptyState isLoading={isLoading} variant={name} columns={numColumns} />
      ) : (
        <View className="relative min-h-0 flex-1">
          <RefreshPill show={hasPending} onPress={applyAndScrollTop} />
          <FlashList
            // Remount on a layout switch — the same fresh scroll/recycler state
            // web's whole-component swap gives, and switches are rare user
            // actions. A rotation only changes numColumns and re-lays out in
            // place, keeping the scroll position.
            key={name}
            ref={listRef}
            data={links}
            extraData={itemExtra}
            numColumns={numColumns}
            // The keyboard pair, and this list is where it matters most: the
            // search box (links/search-bar.tsx) is `autoFocus`, so the common
            // state is a keyboard up over the very results it just filtered.
            // `on-drag` is the dismissal — scrolling the results is the gesture
            // already in the user's hand, and nothing else here offers one
            // (the box's own return key does blur, but it is off at the top of
            // the screen by then). `"handled"` is the other half: FlashList
            // forwards these to its ScrollView, whose default `"never"` would
            // eat the first tap on a result and open nothing.
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={contentPadding ? { padding: contentPadding } : undefined}
            keyExtractor={(link) => link.path}
            getItemType={itemType ? (link) => itemType(link, tagsById) : undefined}
            renderItem={renderItem}
            onScroll={(e) => setScrolled(e.nativeEvent.contentOffset.y > SCROLL_TOP_THRESHOLD)}
            onViewableItemsChanged={onViewableItemsChanged}
            viewabilityConfig={VIEWABILITY_CONFIG}
            // Infinite scroll: grow the page as the end nears. `showMore` grows the
            // read's `limit`; re-arming is implicit — FlashList only re-fires after
            // the content grows.
            onEndReached={() => {
              if (hasMore) showMore();
            }}
            onEndReachedThreshold={0.5}
            // Suspended in bulk-edit mode (see the header), but NEVER unmounted:
            // the control's PRESENCE must hold for the list's lifetime (a fresh
            // element each render is fine). React Native's ScrollView renders a
            // different tree with and without one — on iOS its children go
            // [control, content] ↔ [content], so React remounts the content
            // container; on Android the native ScrollView moves in or out of
            // AndroidSwipeRefreshLayout and remounts whole. Either way every
            // FlashList cell remounts while FlashList's RecyclerView, which sits
            // ABOVE the ScrollView, keeps its layouts and scroll offset — and
            // the cells came back blank (seen on an iPhone) until a later
            // relayout.
            //
            // `enabled` blocks the gesture on Android. iOS has no equivalent, so
            // the handler and the controlled `refreshing` guard it there: a pull
            // still starts the native spinner, and RefreshControl snaps it back
            // at once because `refreshing` never went true — a brief flash,
            // accepted.
            refreshControl={
              <RefreshControl
                enabled={!bulkEditing}
                refreshing={!bulkEditing && refreshing}
                onRefresh={() => {
                  if (bulkEditing) return;
                  setRefreshing(true);
                  applyPending();
                  requestSync();
                }}
              />
            }
          />
        </View>
      )}
      <BulkEditBar links={links} />
    </>
  );
}
