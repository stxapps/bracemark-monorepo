'use client';

// The bar to the right of the sidebar. Left: the active selection's name (what
// the main pane is showing). Right: the primary actions — add, bulk edit,
// overflow (more-options-menu.tsx) — with the search box between them. The
// list/card layout switch used to live here too; it moved to Settings → Misc (a
// choose-once setting with a sync/device split), so the topbar stays minimal.
//
// It carries the frame's whole narrow-width adaptation, in three moves, because
// this is the one bar that survives at every width:
//
//   THE TITLE BECOMES THE RAIL'S DOOR. Below `md` the rail is gone
//   (sidebar.tsx) and this heading — which already names what the rail selects —
//   grows a chevron and opens it as a drawer (sidebar-drawer.tsx). No hamburger
//   slot to pay for, and the word for where you are is the control for going
//   elsewhere.
//
//   THE SEARCH BOX BECOMES A SUMMONED ROW. A phone-width bar can hold a title
//   and four actions or a search box, not both, so below `md` the box moves out
//   of the bar and under it, revealed by a Search toggle — the same shape
//   bracemark-expo settled on (docs/search.md), so the two clients teach one
//   habit. Visibility is the derived `searchVisible` (view-state-provider), and
//   DISMISSING a committed search restores the view it was summoned from —
//   otherwise closing the row would leave the list filtered by a query with
//   nothing left on screen to show or clear it.
//
//   THE ACTIONS SHED THEIR LABELS, NOT THEMSELVES. "Add" loses its word below
//   `sm`; every action keeps its slot at every width. Nothing here hides in an
//   overflow menu on a phone — these four are the page's whole verb set.
//
// The overflow menu (More options) and bulk edit are wired up (the latter
// toggles view-state-provider's `bulkEditing` — rows become selectable and the
// main pane shows the BulkEditToolbar).

import { useCallback } from 'react';
import { Search, SquarePen } from 'lucide-react';

import { ALL_LABEL, DEFAULT_LIST_ID, flattenTree } from '@stxapps/shared';
import { useLists, useTags } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { LinkAddPopover } from '../_components/link-add-popover';
import { MoreOptionsMenu } from '../_components/more-options-menu';
import { SearchBar } from '../_components/search-bar';
import { useLinksPage } from '../_contexts/page-provider';
import { type SimpleSelection, useLinksViewState } from '../_contexts/view-state-provider';
import { SidebarDrawer } from './sidebar-drawer';

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
    // its override name, not the code default. Flatten since the match may be at
    // any depth.
    return flattenTree(lists).find((n) => n.item.id === selection.id)?.item.name ?? 'Unknown';
  }
  return flattenTree(tags).find((n) => n.item.id === selection.id)?.item.name ?? 'Unknown';
}

export function Topbar() {
  const label = useSelectionLabel();
  const { selection, setSimpleQuery } = useLinksPage();
  const {
    bulkEditing,
    enterBulkEdit,
    exitBulkEdit,
    searchVisible,
    setSearchOpen,
    preSearch,
    setPreSearch,
  } = useLinksViewState();

  // Closing DISMISSES the search: with the row gone, a committed search ('none'
  // selection) would keep filtering the list with no visible surface left to
  // show or clear it — so return to where the search began, or home if there's
  // no snapshot. Both targets are `SimpleSelection`s, so neither can resolve
  // back to 'none' and force the row open again. A plain list/tag view (nothing
  // committed, or a single-list/tag advanced search) just hides the row and
  // stays put.
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    if (selection.kind === 'none') setSimpleQuery(preSearch ?? HOME_SELECTION);
  }, [selection, setSimpleQuery, preSearch, setSearchOpen]);

  const toggleSearch = () => {
    if (!searchVisible) {
      // Snapshot where the user is, so dismissing a committed search returns
      // here. Always simple in this branch — a 'none' selection forces the row
      // visible, so opening can't happen under one; the explicit guard is what
      // proves that to TS.
      if (selection.kind !== 'none') setPreSearch(selection);
      setSearchOpen(true);
      return;
    }
    closeSearch();
  };

  // The row and the bulk-edit toolbar are the same 3rem of a phone screen, and
  // bulk edit is a mode you're IN — so entering it takes the slot. Leaving
  // restores the row, since `searchVisible` is derived, not stored.
  const showSearchRow = searchVisible && !bulkEditing;

  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        {/* One `h1` at every width — what changes is whether its content is a
            plain label (the rail is showing, so the title is only a title) or
            the button that opens the rail. A button is phrasing content, so it
            nests here legally; two headings, one per breakpoint, would not have
            been legal or honest. */}
        <h1 className="flex min-w-0 flex-1 items-center md:max-w-48 md:flex-initial">
          <span className="flex min-w-0 md:hidden">
            <SidebarDrawer label={label} />
          </span>
          <span className="hidden truncate text-lg font-semibold md:block">{label}</span>
        </h1>

        {/* The inline box, `md` and up. The measure lives HERE, on the slot,
            rather than inside SearchBar — the same component fills the summoned
            row below, where a 28rem cap would strand it mid-bar. */}
        <div className="hidden max-w-md min-w-0 flex-1 md:flex">
          <SearchBar />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant={searchVisible ? 'secondary' : 'ghost'}
            size="icon-sm"
            // The name states what pressing it DOES, which also keeps every
            // state collision-free: closed, it is the only "Search links" on
            // screen (the inline box is `display:none` below `md`, so it isn't
            // in the a11y tree); open, the box owns that name and this becomes
            // "Close search" — which is honest, since dismissing a committed
            // search also restores the view it was run from. And the title
            // button can only read "Search" while a search IS committed, i.e.
            // while this one is named "Close search".
            aria-label={searchVisible ? 'Close search' : 'Search links'}
            aria-expanded={searchVisible}
            onClick={toggleSearch}
            className="md:hidden"
          >
            <Search className="size-4" />
          </Button>
          <LinkAddPopover />
          <Button
            variant={bulkEditing ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label="Bulk edit"
            aria-pressed={bulkEditing}
            onClick={() => (bulkEditing ? exitBulkEdit() : enterBulkEdit())}
          >
            <SquarePen className="size-4" />
          </Button>
          <MoreOptionsMenu />
        </div>
      </header>

      {/* The summoned row. `md:hidden` as well as conditional, so widening the
          window past the breakpoint hands search back to the inline box instead
          of showing both. Escape dismisses it the way it dismisses every other
          summoned surface on the page. */}
      {showSearchRow && (
        <div
          className={cn('shrink-0 border-b border-border px-4 py-2 md:hidden')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeSearch();
          }}
        >
          <SearchBar autoFocus />
        </div>
      )}
    </>
  );
}
