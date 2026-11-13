'use client';

// Hooks shared by the link layouts and their row parts: the displayed-window
// reporter, the view-change scroll reset, the return-from-reader row restore, the
// tag id→name map, and the
// engagement-aware open state used by the row overlays (menu + tag overflow
// popover).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { linkIdOf, treeNameMap } from '@stxapps/shared';
import { type LinkView, useLinkPreviews, useTags } from '@stxapps/web-react';

import { useLinksPage } from '../../_contexts/page-provider';
import { useLinksViewState } from '../../_contexts/view-state-provider';

import { clearReturnRow, linksHrefOf, peekReturnRow } from '@/lib/links-return';

// How long the displayed window must hold still before we report it. Virtual scrolling moves
// the window every frame; debouncing to the trailing edge reports where the user SETTLES (and
// only those rows), not every transient window a fast scroll flew past.
const REPORT_SETTLE_MS = 300;

// Report the on-screen link window to the automatic-extraction loop (link-previews-provider), so
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
  const { reportDisplayedLinkPaths } = useLinkPreviews();

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

// The most rows a restore will page in looking for its link. The row can be gone
// from the view it was opened from — trashed, moved to another list, deleted by a
// sync while the reader was open — and the only way to learn that is to run out of
// pages; this bounds what a lost cause costs (20 pages is 20 reads of an ever
// larger prefix) to a number nobody scrolls past by hand in one sitting.
const RESTORE_MAX_LINKS = 1000;

// Put the pane back on the row the reader was opened from, once, when the links
// page mounts for the return (✕ or Back). The route alone brings the view back at
// its top and its first page: the trip to `/read` unmounted the links tree, and the
// scroll offset and the "show more" depth lived in it. Expo does not need this —
// the reader is a card on the stack and the list under it never unmounts — which is
// why this is a web-only hook (docs/reader.md, _the web reader_).
//
// It keys on the LINK, not on an offset (lib/links-return.ts says why): the row is
// looked for in the loaded page, and while it is not there and more exist, the page
// grows — the same `showMore` the infinite-scroll effect calls, gated on the loaded
// count the same way so a render in between does not ask twice. When the row lands
// the layout scrolls it to the centre (`scrollToLink` takes the LINK index; the card
// layout turns that into its row) and the restore is over.
//
// It ends, and clears its record, in every case — found, not found (the view is out
// of pages, or past RESTORE_MAX_LINKS), or the user took the scroll first (a wheel,
// a touch, a key or a press on the pane): a jump that lands after the user has
// started scrolling is worse than no restore. A record for a DIFFERENT view is
// ignored and left alone — the view the user left may still be on its way back.
//
// `ready` is the layout saying its scroller is mounted and measured. The card layout
// cannot place a row before it has a column count, and the list layout has no
// scroller while its empty state shows; scrolling earlier lands on a guess.
//
// MUST be called unconditionally, before a layout's empty-state early return.
export function useRestoreReturnRow({
  links,
  isLoading,
  hasMore,
  showMore,
  ready,
  getScrollElement,
  scrollToLink,
}: {
  links: LinkView[];
  isLoading: boolean;
  hasMore: boolean;
  showMore: () => void;
  ready: boolean;
  getScrollElement: () => HTMLElement | null;
  scrollToLink: (linkIndex: number) => void;
}): void {
  const href = linksHrefOf(useSearchParams().toString());
  // undefined: not read yet; null: nothing to restore here; string: the link id.
  const targetRef = useRef<string | null | undefined>(undefined);
  const doneRef = useRef(false);
  const askedAtLengthRef = useRef(-1);
  const latest = useRef({ getScrollElement, scrollToLink, showMore });
  latest.current = { getScrollElement, scrollToLink, showMore };

  useEffect(() => {
    if (doneRef.current) return;
    if (targetRef.current === undefined) targetRef.current = peekReturnRow(href) ?? null;
    const id = targetRef.current;
    if (id === null) {
      doneRef.current = true;
      return;
    }
    if (isLoading) return;

    const finish = () => {
      doneRef.current = true;
      clearReturnRow();
    };
    const index = links.findIndex((link) => linkIdOf(link) === id);
    if (index >= 0) {
      if (!ready) return;
      latest.current.scrollToLink(index);
      finish();
    } else if (hasMore && links.length < RESTORE_MAX_LINKS) {
      if (askedAtLengthRef.current !== links.length) {
        askedAtLengthRef.current = links.length;
        latest.current.showMore();
      }
    } else {
      finish();
    }
  }, [href, links, isLoading, hasMore, ready]);

  // The user taking the scroll ends it. Listens on the pane while a restore is
  // pending only; `capture` so a row's own handler stopping the event cannot hide it.
  useEffect(() => {
    if (!ready || doneRef.current) return;
    const element = latest.current.getScrollElement();
    if (!element) return;
    const abandon = () => {
      doneRef.current = true;
      clearReturnRow();
    };
    const events = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
    for (const type of events) element.addEventListener(type, abandon, { capture: true });
    return () => {
      for (const type of events) element.removeEventListener(type, abandon, { capture: true });
    };
  }, [ready, links.length]);
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
