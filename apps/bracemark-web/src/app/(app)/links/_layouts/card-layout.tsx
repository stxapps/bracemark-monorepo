'use client';

// Grid-of-previews layout. Virtualized by ROW (each virtual item is a row of
// `columns` cards, where `columns` tracks the container width) — the simplest
// way to virtualize a uniform grid: divide the
// link list into chunks and lay each chunk out with a flex/grid row. Card height
// is fixed so the row estimate stays exact.

import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { displayUrl, hostFromText } from '@stxapps/shared';
import { useElementWidth } from '@stxapps/web-ui/hooks/use-element-size';
import { useRootFontScale } from '@stxapps/web-ui/hooks/use-root-font-scale';

import { useLinksViewState } from '../_contexts/view-state-provider';
import {
  EmptyState,
  Favicon,
  type LinkLayoutProps,
  LinkPreviewImage,
  LinkRowMenu,
  LinkRowSelect,
  LinkTagChips,
  NoteBadge,
  PinnedBadge,
  RefreshPill,
  ShowMore,
  useReportDisplayedLinkPaths,
  useTagMap,
} from './shared';

// Column count tracks the scroll container's content width (below) rather than a
// fixed 3, so cards keep a comfortable width from the extension popup up to a
// wide monitor. `MIN_CARD_WIDTH` is the smallest a card may get before we drop a
// column; `CARD_GAP` is the grid `gap-4` (16px), needed by the fit math.
const MIN_CARD_WIDTH = 300;
const CARD_GAP = 16;
const DEFAULT_COLUMNS = 3;
// Fixed card budget: preview banner (112) + p-3 text block (host 20 + gap 8 +
// two title lines 40 + padding 24) + up to two chip lines + pb-3 (56 —
// LinkTagChips maxLines={2} measures the fit, so the block never exceeds two
// lines) + the row's pb-4 (16). Cards with less content keep the height — the
// grid stretches every card to the row height and the unused space falls at the
// BOTTOM (content flows top-down; the anchor is NOT flex-1) — so the row estimate
// stays exact. Height is fixed regardless of card WIDTH, so a variable column
// count leaves it exact.
//
// No line is budgeted for the link's note: a fixed estimate can't be conditional,
// so an inline note would cost its line on EVERY card — and most links have none.
// Both layouts therefore badge it (NoteBadge) and leave the text to hover and the
// row menu's "View note".
//
// Scaled by the root font size (useRootFontScale) for the same reason as
// list-layout's row, and see that file's note for the full argument: every part
// of this budget is rem — Tailwind v4 sizes text from `--text-sm`/`--text-xs`
// AND spacing from `--spacing: 0.25rem`, so `h-28`, `p-3`, `gap-4` scale too —
// while the number itself would not, and the card's `overflow-hidden` swallows
// the difference. So the whole budget scales UNIFORMLY; there is no
// meaningfully unscaled part to hold back (unlike the native card in
// bracemark-expo, which does split — RN has no rem and its font scale moves
// fontSize alone).
const ROW_HEIGHT = 280;
const SCROLL_TOP_THRESHOLD = 8;

export function CardLayout({
  links,
  pinnedCount,
  hasMore,
  showMore,
  isLoading,
  hasPending,
  applyPending,
}: LinkLayoutProps) {
  // The scroll container as STATE (via a callback ref), not a RefObject: that's
  // what lets useElementWidth re-measure when the element mounts. It matters here
  // because the div is absent while EmptyState shows, so a RefObject would leave
  // the width stuck at 0 (→ DEFAULT_COLUMNS) after a 0→N links transition. The
  // virtualizer and scrollTo read the same node.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const { setScrolled, bulkEditing, selectedLinks, toggleSelected, selectRange } =
    useLinksViewState();
  const tagsById = useTagMap();
  // Fit as many `MIN_CARD_WIDTH` cards (plus gaps) as the content box holds; fall
  // back to `DEFAULT_COLUMNS` until the first measurement lands so there's no
  // 1-column flash on the initial paint (matches the prior fixed layout).
  const contentWidth = useElementWidth(scrollEl);
  const columns =
    contentWidth > 0
      ? Math.max(1, Math.floor((contentWidth + CARD_GAP) / (MIN_CARD_WIDTH + CARD_GAP)))
      : DEFAULT_COLUMNS;
  const rowCount = Math.ceil(links.length / columns);
  // Ceil so rounding can only ever give the content MORE room, never less.
  const rowHeight = Math.ceil(ROW_HEIGHT * useRootFontScale());

  useEffect(() => {
    setScrolled(false);
    return () => setScrolled(false);
  }, [setScrolled]);

  const applyAndScrollTop = () => {
    applyPending();
    scrollEl?.scrollTo({ top: 0 });
  };

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollEl,
    estimateSize: () => rowHeight,
    overscan: 4,
  });

  // A changed `estimateSize` doesn't invalidate the cached measurements on its
  // own, so re-measure when the root font size moves (rare — a browser
  // preference change, plus the once-per-mount 1 → real correction).
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  // Virtual items are ROWS of `columns` cards, so the displayed LINK range is the first row's
  // first card through the last row's last card (the hook clamps the tail to `links.length`).
  const rows = virtualizer.getVirtualItems();
  useReportDisplayedLinkPaths(
    links,
    rows.length ? rows[0].index * columns : 0,
    rows.length ? rows[rows.length - 1].index * columns + columns - 1 : -1,
  );

  // Infinite scroll: grow the page automatically as the last ROW comes within
  // `overscan` of the viewport (virtual index counts rows, hence `rowCount`).
  // `ShowMore` below stays as the keyboard/AT fallback and the "there's more" cue.
  // `showMore` grows `limit` by a fixed step per call and `rows` is a fresh array
  // every render, so we gate on the loaded count: fire once per page, re-arm only
  // once the next page's rows actually land (`links.length` changes).
  const autoLoadedLengthRef = useRef(-1);
  useEffect(() => {
    if (!hasMore) return;
    const last = rows[rows.length - 1];
    if (last && last.index >= rowCount - 1 && autoLoadedLengthRef.current !== links.length) {
      autoLoadedLengthRef.current = links.length;
      showMore();
    }
  }, [rows, hasMore, rowCount, links.length, showMore]);

  if (links.length === 0) return <EmptyState isLoading={isLoading} variant="card" />;

  return (
    <div className="relative h-full">
      <RefreshPill show={hasPending} onClick={applyAndScrollTop} />
      <div
        ref={setScrollEl}
        className="h-full overflow-y-auto p-4"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > SCROLL_TOP_THRESHOLD)}
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((virtualRow) => {
            const start = virtualRow.index * columns;
            const rowLinks = links.slice(start, start + columns);
            return (
              <div
                key={virtualRow.key}
                className="absolute inset-x-0 grid gap-4 pb-4"
                style={{
                  height: rowHeight,
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {rowLinks.map((link, cardIndex) => {
                  const index = start + cardIndex;
                  const pinned = index < pinnedCount;
                  const selected = bulkEditing && selectedLinks.has(link.path);
                  return (
                    <div
                      key={link.path}
                      className={`relative flex flex-col overflow-hidden rounded-lg border border-border ${
                        selected ? 'bg-muted' : 'hover:bg-muted/50'
                      }`}
                    >
                      {/* The tag chips are buttons, so they sit OUTSIDE the anchor
                          as the card's bottom block (same no-button-in-anchor rule
                          as LinkRowMenu). The anchor is NOT flex-1: content flows
                          top-down and the fixed-height slack falls below the tags
                          (reads as bottom padding, not a mid-card gap). */}
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex min-w-0 flex-col"
                        // In bulk-edit mode the card's click toggles selection
                        // instead of opening the link (middle/cmd-click still
                        // opens); shift-click extends a range over `links`.
                        onClick={
                          bulkEditing
                            ? (e) => {
                                e.preventDefault();
                                if (e.shiftKey) selectRange(link, links);
                                else toggleSelected(link);
                              }
                            : undefined
                        }
                      >
                        <LinkPreviewImage
                          link={link}
                          className="h-28 w-full shrink-0"
                          fallback="panel"
                        />
                        <div className="flex min-w-0 flex-col gap-2 p-3">
                          <div className="flex items-center gap-2">
                            {pinned && <PinnedBadge />}
                            {link.note && <NoteBadge note={link.note} />}
                            <Favicon host={hostFromText(link.url)} className="size-4 shrink-0" />
                            <span className="truncate text-xs text-muted-foreground">
                              {hostFromText(link.url)}
                            </span>
                          </div>
                          <span className="line-clamp-2 text-sm font-medium">
                            {link.title || displayUrl(link.url)}
                          </span>
                        </div>
                      </a>
                      <LinkTagChips
                        link={link}
                        tagsById={tagsById}
                        maxLines={2}
                        className="px-3 pb-3"
                      />
                      {/* Floats over the banner now, so give it a readable pad. */}
                      <div className="absolute top-1 right-1 rounded-md bg-background/60">
                        {bulkEditing ? (
                          <LinkRowSelect link={link} links={links} />
                        ) : (
                          <LinkRowMenu
                            link={link}
                            pinned={pinned}
                            isFirst={index === 0}
                            isLast={index === pinnedCount - 1}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <ShowMore hasMore={hasMore} showMore={showMore} />
      </div>
    </div>
  );
}
