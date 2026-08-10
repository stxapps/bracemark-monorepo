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
import { FlashList, type FlashListRef, type ViewToken } from '@shopify/flash-list';

import { type LinkView, useExtraction, useLocks, useSettings, useSync } from '@stxapps/expo-react';

import { LockPane } from '../../components/lock-pane';
import { BulkEditBar } from './bulk-edit-bar';
import { LinkCard } from './link-card';
import { LinkRow } from './link-row';
import { useLinksPage } from './page-provider';
import { EmptyState, type LinkItemProps, RefreshPill, useTagMap } from './shared';
import { useLinks } from './use-links';
import { useLinksViewState } from './view-state-provider';

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

// The smallest a card may get before the card grid drops a column — web's
// MIN_CARD_WIDTH rationale at mobile scale: web's 300 would pin every phone to
// one column (a bloated list); 180 yields 2 columns on phones and 4–5 on
// tablets, where the card is a compact tile rather than web's wide preview.
const MIN_CARD_WIDTH = 180;
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
  columns: (paneWidth: number) => number;
  contentPadding: number;
};

const LIST_LAYOUT: LayoutConfig = {
  name: 'list',
  Item: LinkRow,
  columns: () => 1,
  contentPadding: 0,
};
const CARD_LAYOUT: LayoutConfig = {
  name: 'card',
  Item: LinkCard,
  columns: (paneWidth) => Math.max(1, Math.floor(paneWidth / MIN_CARD_WIDTH)),
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
          title="This list is locked"
          description="Enter the list's password to view its links."
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
  const { setScrolled, bulkEditing, selectedLinks, toggleSelected } = useLinksViewState();
  const { bgSyncStatus, requestSync } = useSync();
  const tagsById = useTagMap();
  const listRef = useRef<FlashListRef<LinkView>>(null);

  // Feed the extraction drain the rows actually on screen, so automatic preview
  // work tracks ATTENTION — a 30k-link import never extracts past what was
  // scrolled into view (extraction-provider, cost layer 2).
  //
  // TRAP: FlashList captures `onViewableItemsChanged` once (changing its
  // identity mid-list throws "Changing onViewableItemsChanged on the fly is not
  // supported"), so the callback must be stable for the list's whole lifetime.
  // Hence a `[]`-dep useCallback reading the latest reporter through a ref,
  // rather than closing over it directly.
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

  const { name, Item, columns, contentPadding } = LAYOUTS[linksLayout] ?? LIST_LAYOUT;
  // Window width, not a measured container: the pane fills the screen, and the
  // window value is available synchronously — no DEFAULT_COLUMNS flash to paper
  // over (web's useElementWidth dance isn't needed here).
  const numColumns = columns(useWindowDimensions().width);

  // FlashList compares extraData by reference to decide whether items must
  // re-render; memoized so scroll-flag renders of this pane don't force a
  // re-render of every item, while a selection toggle (new map identity), a tag
  // rename (tagsById — renames must repaint immediately, see useTagMap), or a
  // sort change (the row's date column) does.
  const itemExtra = useMemo(
    () => ({ bulkEditing, selectedLinks, tagsById, sortOn: query.sortOn }),
    [bulkEditing, selectedLinks, tagsById, query.sortOn],
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

  const applyAndScrollTop = () => {
    applyPending();
    listRef.current?.scrollToOffset({ offset: 0 });
  };

  return (
    <>
      {links.length === 0 ? (
        <EmptyState isLoading={isLoading} variant={name} />
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
            contentContainerStyle={contentPadding ? { padding: contentPadding } : undefined}
            keyExtractor={(link) => link.path}
            renderItem={({ item, index }) => (
              <Item
                link={item}
                pinned={index < pinnedCount}
                // The pinned section's ends, for the row menu's Move up/down
                // (meaningful only when pinned; pins sort first, so flat
                // indexes 0..pinnedCount-1 are exactly the pinned section).
                isFirst={index === 0}
                isLast={index === pinnedCount - 1}
                sortOn={query.sortOn}
                tagsById={tagsById}
                selectMode={bulkEditing}
                selected={selectedLinks.has(item.path)}
                onToggle={() => toggleSelected(item)}
              />
            )}
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
            // Suspended in bulk-edit mode (see the header); `enabled` is
            // Android-only, so the control is omitted entirely instead.
            refreshControl={
              bulkEditing ? undefined : (
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => {
                    setRefreshing(true);
                    applyPending();
                    requestSync();
                  }}
                />
              )
            }
          />
        </View>
      )}
      <BulkEditBar links={links} />
    </>
  );
}
