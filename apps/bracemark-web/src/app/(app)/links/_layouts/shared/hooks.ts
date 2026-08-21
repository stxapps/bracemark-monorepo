'use client';

// Hooks shared by the link layouts and their row parts: the displayed-window
// reporter, the view-change scroll reset, the tag id→name map, and the
// engagement-aware open state used by the row overlays (menu + tag overflow
// popover).

import { useEffect, useMemo, useRef, useState } from 'react';

import { treeNameMap } from '@stxapps/shared';
import { type LinkView, useExtraction, useTags } from '@stxapps/web-react';

import { useLinksPage } from '../../_contexts/page-provider';
import { useLinksViewState } from '../../_contexts/view-state-provider';

// How long the displayed window must hold still before we report it. Virtual scrolling moves
// the window every frame; debouncing to the trailing edge reports where the user SETTLES (and
// only those rows), not every transient window a fast scroll flew past.
const REPORT_SETTLE_MS = 300;

// Report the on-screen link window to the automatic-extraction loop (extraction-provider), so
// it extracts what the user is actually looking at — the "displayed" set the provider drains
// (see `reportDisplayedLinkPaths`). Bounded to O(displayed) — a few dozen rows — no matter how
// far "show more" has grown `links`: reporting the whole loaded page instead would re-scan
// thousands of paths on every probe re-run (the provider's liveQuery fires on each store
// write). Each layout owns a virtualizer with its own geometry, so it resolves the displayed
// LINK index range itself and passes [startIndex, endIndex] (inclusive); this maps the range to
// paths, debounced to the scroll's trailing edge. MUST be called unconditionally before a
// layout's empty-state early return (hooks rule); an empty range (`endIndex < 0`) reports `[]`,
// which pauses the loop — matching `reportDisplayedLinkPaths`'s "no links shown" contract.
export function useReportDisplayedLinkPaths(
  links: LinkView[],
  startIndex: number,
  endIndex: number,
): void {
  const { reportDisplayedLinkPaths } = useExtraction();

  useEffect(() => {
    const id = setTimeout(() => {
      const paths: string[] = [];
      for (let i = Math.max(0, startIndex); i <= endIndex && i < links.length; i++) {
        paths.push(links[i].path);
      }
      reportDisplayedLinkPaths(paths);
    }, REPORT_SETTLE_MS);

    return () => clearTimeout(id);
  }, [links, startIndex, endIndex, reportDisplayedLinkPaths]);
}

// Put the pane back at the top when the VIEW changes. Each layout owns its own
// scroll container, and a query change leaves that container's offset exactly
// where the previous view left it — so the hook lives here and both layouts call
// it, rather than each spelling the same effect.
//
// It is not cosmetic, and the bad case is worse than "you land mid-list".
// `useLinks` resets `limit` to PAGE_SIZE on the same change (a new query is a
// fresh page), so the new view is at most one page tall while the offset carries
// over from a view that may have been paged far deeper. Whenever that offset
// exceeds the new content height the browser clamps it to the maximum — landing
// the user at the BOTTOM of a list they never scrolled, which immediately
// satisfies both layouts' infinite-scroll effect and pages it further.
//
// Keyed on the `query` IDENTITY, not on `selection`: selection is the lossy
// single-axis projection, so it holds still across two different searches and
// doesn't move at all for a sort change — which reorders every row and makes the
// offset just as meaningless. This is the same trigger `use-links` resets `limit`
// on and `view-state-provider` exits bulk-edit on, reading the same stable
// per-view reference (page-provider memoizes it off the URL).
//
// The scroller arrives as a GETTER, matching the virtualizer's own
// `getScrollElement`: list-layout holds a RefObject and card-layout holds state,
// so neither is a value this hook could take as a dep. Read through a ref so the
// effect's deps stay honest without re-running on every render.
//
// `setScrolled(false)` rides along for the reason both layouts already reset it
// on mount: left true, a scroll position that no longer exists keeps `engaged`
// pinned and stages every background sync behind the refresh pill.
//
// The reset fires when the query changes, which is a tick BEFORE useLinks
// promotes the new page — so what shows for that tick is the top of the OLD list.
// That is the right way round: the alternative is the old list sitting at its old
// offset until the read lands.
export function useScrollTopOnQuery(getScrollElement: () => HTMLElement | null): void {
  const { query } = useLinksPage();
  const { setScrolled } = useLinksViewState();
  const getScrollElementRef = useRef(getScrollElement);
  getScrollElementRef.current = getScrollElement;
  const prevQueryRef = useRef(query);

  useEffect(() => {
    if (prevQueryRef.current === query) return;
    prevQueryRef.current = query;
    getScrollElementRef.current()?.scrollTo({ top: 0 });
    setScrolled(false);
  }, [query, setScrolled]);
}

// Flatten the live tag tree into an id → name map (shared's `treeNameMap`),
// hoisted ONCE per layout and passed to the rows (a per-row useTags would mount
// one liveQuery per virtual row). Live, so a rename repaints the chips
// immediately — tag names are deliberately NOT part of useLinks' staged snapshot:
// a rename isn't a row reorder, so it must never wait behind the refresh pill.
export function useTagMap(): Map<string, string> {
  const tree = useTags();
  return useMemo(() => treeNameMap(tree), [tree]);
}

// Controlled open state for a row-anchored overlay (the row menu, the tag
// overflow popover), reporting open/close into the hoisted engagement count
// (setMenuOpen) so a background sync won't repaint the row — moving or
// unmounting the trigger — while the overlay is open; see view-state-provider.
// Tracks its own open flag so an unmount-while-open (e.g. a layout switch)
// releases the count instead of leaking it and pinning `engaged` true forever.
// Idempotent on repeated same-state calls — the count is shared, so a stray
// close must not decrement another overlay's increment.
export function useEngagedOpen(): [boolean, (open: boolean) => void] {
  const { setMenuOpen } = useLinksViewState();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  useEffect(
    () => () => {
      if (openRef.current) setMenuOpen(false);
    },
    [setMenuOpen],
  );
  const handleOpenChange = (nextOpen: boolean) => {
    if (openRef.current === nextOpen) return;
    openRef.current = nextOpen;
    setOpen(nextOpen);
    setMenuOpen(nextOpen);
  };
  return [open, handleOpenChange];
}
