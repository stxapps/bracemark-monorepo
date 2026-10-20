'use client';

// The bar to the right of the sidebar. Left: the active selection's name (what
// the main pane is showing). Right: the primary actions — add, then search,
// bulk edit, overflow (more-options-menu.tsx) — with the search box between the
// title and them. The list/card layout switch used to live here too; it moved to
// Settings → Misc (a choose-once setting with a sync/device split), so the
// topbar stays minimal.
//
// It carries the frame's whole narrow-width adaptation, in three moves, because
// this is the one bar that survives at every width:
//
//   THE TITLE BECOMES THE RAIL'S DOOR. Below `md` the rail is gone
//   (sidebar.tsx) and this heading — which already names what the rail selects —
//   grows a chevron and opens it as a drawer (sidebar-drawer.tsx). No hamburger
//   slot to pay for, and the word for where you are is the control for going
//   elsewhere. The same happens at any width while the user has COLLAPSED the
//   rail, plus a "Show sidebar" control ahead of the title to dock it again.
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
//   THE ACTIONS ARE WORDLESS, BUT NOT ONE OF THEM HIDES. All four are icon-only
//   at every width — Add gave up its word too, since what marks it as the one
//   that CREATES is its fill and the gap holding it off the other three, not a
//   label (link-add-surface.tsx carries that reasoning; the empty pane's CTA is
//   where the word still teaches the verb). Nothing folds into an overflow menu
//   on a phone either: these four are the page's whole verb set.
//
// The overflow menu (More options) and bulk edit are wired up (the latter
// toggles view-state-provider's `bulkEditing` — rows become selectable and the
// main pane shows the BulkEditToolbar).

import { useCallback, useEffect, useRef, useState } from 'react';
import { PanelLeftOpen, Search, SquarePen } from 'lucide-react';

import { ALL_LABEL, flattenTree } from '@stxapps/shared';
import { useLists, useTags } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { useElementWidth } from '@stxapps/web-ui/hooks/use-element-size';
import { cn } from '@stxapps/web-ui/lib/utils';

import { LinkAddSurface } from '../_components/link-add-surface';
import { MoreOptionsMenu } from '../_components/more-options-menu';
import { SearchBar } from '../_components/search-bar';
import { useLinksPage } from '../_contexts/page-provider';
import { useLinksViewState } from '../_contexts/view-state-provider';
import {
  RAIL_SHORTCUT_ARIA,
  railShortcutHint,
  setRailCollapsed,
  SHOW_RAIL_ATTR,
  takeRailFocus,
  useSidebarRail,
} from '../_hooks/use-sidebar-rail';
import { SidebarDrawer } from './sidebar-drawer';

function useSelectionLabel(): string {
  const { selection } = useLinksPage();
  const lists = useLists();
  const tags = useTags();

  if (selection.kind === 'all') return ALL_LABEL;
  // A text search or compound/multi filter has no single-axis name — title the
  // view generically rather than borrowing a stale list/tag name.
  if (selection.kind === 'none') return 'Search';
  // A name the tree can't supply is BLANK, never a word. Whether the id is GONE
  // is not this hook's call: page-provider judges that (isStaleSelection) and
  // hands down home in its place, so what arrives here unnamed is something else
  // — a tree not read back yet (useLists/useTags collapse "still loading" into
  // `[]`, docs/search.md), this hook's tree a read ahead of the provider's (each
  // call is its own live read), or the one tag view the provider can't judge.
  // The word that used to stand here, "Unknown", was wrong in all three, and
  // flashed over every cold mount — the default inbox included — and again
  // after every delete.
  //
  // Look the name up in the merged list tree — so a renamed system list shows
  // its override name, not the code default. Flatten since the match may be at
  // any depth.
  if (selection.kind === 'list') {
    return flattenTree(lists).find((n) => n.item.id === selection.id)?.item.name ?? '';
  }
  return flattenTree(tags).find((n) => n.item.id === selection.id)?.item.name ?? '';
}

// Docks the rail again, from `md` up, while it is collapsed — the counterpart of
// the rail's own Hide control, and the one that catches focus when Hide is
// pressed from the keyboard (use-sidebar-rail.ts, _focus handoff_). Below `md`
// there is no rail to dock; the title is the drawer's door there either way.
function ShowRailButton() {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (takeRailFocus('show')) ref.current?.focus();
  }, []);

  return (
    <Button
      ref={ref}
      {...{ [SHOW_RAIL_ATTR]: '' }}
      variant="ghost"
      size="icon"
      aria-label="Show sidebar"
      aria-keyshortcuts={RAIL_SHORTCUT_ARIA}
      title={`Show sidebar (${railShortcutHint()})`}
      onClick={() => setRailCollapsed(false)}
      // `-ml-2` pulls the 36px box's empty margin into the bar's 16px inset, so
      // the glyph lands about where the rail's lockup mark sat.
      className="-ml-2 hidden shrink-0 md:inline-flex"
    >
      <PanelLeftOpen className="size-4" />
    </Button>
  );
}

// The bar's content width, in rem, below which Bulk edit moves from a button into
// More options. The actions take 10.25rem (four 2.25rem squares and their gaps),
// the header's gap 0.75, and the title needs about 5 to show a short list name
// beside the drawer chevron. In rem, not px, because what squeezes the bar is
// TEXT SIZE as much as width: at a 320px viewport the title kept 85px at the
// default 16px and 8px — nothing — at 24px, while every button grew to 54.
// So a phone at the default size keeps its button (and every flow that clicks
// it), and the menu takes it only where the title would otherwise vanish.
const COMPACT_BAR_REM = 16;

export function Topbar() {
  const label = useSelectionLabel();
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const headerWidth = useElementWidth(header);
  // 0 until measured (SSR, first paint): full bar until then. The root size is
  // read here rather than cached — it is the user's setting and can change.
  const compact =
    headerWidth > 0 &&
    headerWidth < COMPACT_BAR_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);
  const { collapsed: railCollapsed } = useSidebarRail();
  const {
    bulkEditing,
    enterBulkEdit,
    exitBulkEdit,
    searchVisible,
    setSearchOpen,
    restorePreSearch,
  } = useLinksViewState();

  // Closing DISMISSES the search: with the row gone, a committed search ('none'
  // selection) would keep filtering the list with no visible surface left to
  // show or clear it — so `restorePreSearch` returns to where the search began,
  // or home if nothing simple has been seen yet. A plain list/tag view (nothing
  // committed, or a single-list/tag advanced search) just hides the row and
  // stays put, which is that call's own no-op branch. The box's ✕ and an
  // emptied box (search-bar.tsx) run the same body — and above `md`, where this
  // toggle doesn't render, they are the only exits there are.
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    restorePreSearch();
  }, [restorePreSearch, setSearchOpen]);

  const toggleSearch = () => {
    if (!searchVisible) {
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
      <header
        ref={setHeader}
        className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4"
      >
        {railCollapsed && <ShowRailButton />}

        {/* One `h1` at every width — what changes is whether its content is a
            plain label (the rail is showing, so the title is only a title) or
            the button that opens the rail. A button is phrasing content, so it
            nests here legally; two headings, one per breakpoint, would not have
            been legal or honest.

            "The rail is showing" is the breakpoint AND the rail's dock state:
            collapsed, the frame is one-pane at every width, so the title is the
            drawer's door at every width too — a list stays one click away
            without docking the rail back. */}
        <h1 className="flex min-w-0 flex-1 items-center md:max-w-48 md:flex-initial">
          <span className={cn('flex min-w-0', !railCollapsed && 'md:hidden')}>
            <SidebarDrawer label={label} />
          </span>
          <span
            className={cn('hidden truncate text-lg font-semibold', !railCollapsed && 'md:block')}
          >
            {label}
          </span>
        </h1>

        {/* The inline box, `md` and up. The measure lives HERE, on the slot,
            rather than inside SearchBar — the same component fills the summoned
            row below, where a 28rem cap would strand it mid-bar. */}
        <div className="hidden max-w-md min-w-0 flex-1 md:flex">
          <SearchBar />
        </div>

        {/* `ml-auto` because the search slot above freezes at its cap: past
            that width the bar has leftover space, and flex-start would leave it
            all to the RIGHT of these buttons, floating them mid-bar. The auto
            margin banks it on the left instead, so the actions stay in the
            corner at every width — matching where they already sit below `md`
            (no search slot to cap) and where the bulk-edit toolbar's own right
            group sits in the bar directly beneath this one.

            Every control in this group is a 36 square — `icon` for the three
            ghosts, `default` plus an explicit `w-9` for Add — matching the
            search box's height beside it, so the bar reads as one band rather
            than a tall field next to short buttons.
            The icons stay `size-4`: 16 is the grid the sidebar, the drawer and
            the bulk-edit toolbar all use, and that toolbar swaps into the slot
            directly below, where a mismatch would show as a jump.

            TWO FAMILIES, AND THE GAP IS WHAT SAYS SO. Search and Bulk edit are
            mode toggles on the view you're already in — same square box, same
            ghost→secondary state grammar — and More options is the container for
            everything else in this bar, so nothing may sit after it. Add is the
            odd one by kind (it CREATES) and by paint (the only filled control
            here), so it leads and the other three run together: `gap-1` closes
            the trio into one segmented run (safe because ghost buttons have no
            visible edge), `gap-3` holds Add off it. A uniform gap can't express
            that, which is what left Add stranded mid-group when it sat second. */}
        <div className="ml-auto flex shrink-0 items-center gap-3">
          <LinkAddSurface />
          <div className="flex items-center gap-1">
            <Button
              variant={searchVisible ? 'secondary' : 'ghost'}
              size="icon"
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
            {/* Compact (COMPACT_BAR_REM), the toggle is a menu item instead,
                and only for ENTERING: once in the mode, the bulk-edit toolbar's
                own ✕ is the exit. */}
            {!compact && (
              <Button
                variant={bulkEditing ? 'secondary' : 'ghost'}
                size="icon"
                aria-label="Bulk edit"
                aria-pressed={bulkEditing}
                onClick={() => (bulkEditing ? exitBulkEdit() : enterBulkEdit())}
              >
                <SquarePen className="size-4" />
              </Button>
            )}
            <MoreOptionsMenu onBulkEdit={compact && !bulkEditing ? enterBulkEdit : undefined} />
          </div>
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
