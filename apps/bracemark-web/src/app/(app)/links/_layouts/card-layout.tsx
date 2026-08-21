'use client';

// Grid-of-previews layout. Virtualized by ROW (each virtual item is a row of
// `columns` cards, where `columns` tracks the container width) — the simplest way
// to virtualize a uniform grid: chunk the link list and lay each chunk out as a
// grid row.
//
// Row heights are MEASURED, not budgeted — list-layout.tsx carries the argument
// and this layout now follows it. It used to be the one web layout that budgeted,
// on the grounds that a card is stretched to its grid row, so a card's height is a
// property of the ROW rather than of the card. Cards are no longer stretched — each
// one sizes to its own content, so its border hugs it (`items-start` below) — but
// the measurement is untouched by that: a grid row is as tall as its tallest item
// either way, so the row still has ONE height to report, and the virtualizer reads
// it off the row element (`ref={virtualizer.measureElement}` + `data-index`, and no
// `height` in its style).
//
// What that buys: the card fits its CONTENT. A fixed budget had to reserve the
// second title line and the chip line on every card, including the many that use
// neither — and since the card is `overflow-hidden`, under-budgeting clipped
// silently while over-budgeting left dead space at the bottom of every card. It
// also had to be scaled by the root font size (useRootFontScale, now gone from
// this file) because it was a px number against an all-rem card. A measured row is
// simply correct at any root size, and it cannot disagree with what it painted.
//
// Two things keep a row settling in ONE pass rather than oscillating: the banner
// is a fixed ASPECT of the card's width (below), so a late image load can't
// reflow a measured row, and the chip strip is capped at one line.
//
// The card anatomy, top to bottom:
//
//   the banner  — LinkPreviewImage at 12:7 (`aspect-[12/7]`, i.e. its height is
//                 58.33% of the card's width — it scales with the column count
//                 instead of being pinned to one number).
//   the meta line — favicon + host + the pinned/note badges + the ⋯ menu at the
//                 trailing edge. The host reads at `text-base`, the title's size —
//                 the relationship list-layout has at its own denser text-sm. The badges trail the host in all four layouts
//                 (list-layout.tsx has the argument: the host is bounded where the
//                 title is not, so this is the line with slack). The menu joins
//                 them here rather than floating over the banner: nothing covers
//                 the preview any more, and the trigger's 44px hit target expands
//                 into the card's own p-3 instead of into the grid gutter, where
//                 it used to sit 6px from the next card's edge.
//   the title   — `text-base`, `line-clamp-2`. A card is the layout with the most
//                 room per link, so the title reads at body size here; the list
//                 row's text-sm answers to a different constraint (density).
//   the chips   — ONE line (LinkTagChips' default), which is also all
//                 bracemark-expo's strip can do, so both apps show the same chips.
//
// No line is budgeted for the link's note: an inline note would cost its line on
// the many cards that have none, so both layouts badge it (NoteBadge) and leave
// the text to hover and the row menu's "Edit note".

import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { displayUrl, hostFromText } from '@stxapps/shared';
import { useElementWidth } from '@stxapps/web-ui/hooks/use-element-size';

import { useLinksViewState } from '../_contexts/view-state-provider';
import {
  EmptyState,
  Favicon,
  hasKnownTags,
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
  useScrollTopOnQuery,
  useTagMap,
} from './shared';

// Column count tracks the scroll container's content width (below) rather than a
// fixed 3, so cards keep a comfortable width from the extension popup up to a
// wide monitor. `MIN_CARD_WIDTH` is the smallest a card may get before we drop a
// column; `CARD_GAP` is the grid `gap-4` (16px), needed by the fit math.
const MIN_CARD_WIDTH = 300;
const CARD_GAP = 16;
const DEFAULT_COLUMNS = 3;

// The other end of that range, and the reason each card is `mx-auto` inside its
// grid cell: dropping a column can only happen once a cell has grown to twice the
// minimum, so a cell runs up to ~615px wide at one column (a pane between 300 and
// 615 — the browser extension's popup, or a narrow window with the sidebar open).
// A 615px card is a 359px banner and a title stranded on one very long line; the
// cap keeps a card a card, and the cell's leftover width becomes margin either
// side of it. Mirrored by `max-w-105` on the card below (26.25rem — the class is
// the one that renders, this number only feeds the estimates, so under a raised
// root font size the estimate errs small, which is what an estimate should do).
const MAX_CARD_WIDTH = 420;

// The banner's height as a fraction of the card's width: 12:7. Only the estimates
// need it as a number — `aspect-[12/7]` on the slot is what actually lays it out.
const PREVIEW_ASPECT = 7 / 12;

// What a row's TEXT adds to its banner, for rows not yet measured. Both sit
// BETWEEN the two outcomes of the only thing they can't know — whether the title
// wraps to its second line — so the error cancels across a long list instead of
// accumulating in one direction:
//
//   meta line 32 (the ⋯ trigger's size-8 sets it) + gap-2 8 + title 24 or 48
//   + p-3 24 + the row's pb-4 16                      → 104 … 128
//   + one chip line 24 + the strip's pb-3 12          → 140 … 164
const ESTIMATE_BARE = 116;
const ESTIMATE_TAGGED = 152;

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
  // The width one card actually renders at — the cell, capped by `max-w-105` —
  // which is what turns the banner's ASPECT into a number for the estimate below.
  const cardWidth = Math.min(
    contentWidth > 0 ? (contentWidth - CARD_GAP * (columns - 1)) / columns : MIN_CARD_WIDTH,
    MAX_CARD_WIDTH,
  );
  const rowCount = Math.ceil(links.length / columns);

  useEffect(() => {
    setScrolled(false);
    return () => setScrolled(false);
  }, [setScrolled]);

  // ...and back to the top whenever the VIEW changes — this component stays
  // mounted across a sidebar pick, a committed search or a sort change, so
  // nothing else would (see the hook for why the offset can't just be left).
  useScrollTopOnQuery(() => scrollEl);

  const applyAndScrollTop = () => {
    applyPending();
    scrollEl?.scrollTo({ top: 0 });
  };

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollEl,
    // By the first link's PATH rather than the default index (list-layout.tsx's
    // reasoning): a measured height then follows its row across a search or a
    // re-sort instead of describing whichever links used to sit at that position.
    // A row is re-measured on mount anyway, so a row whose COMPANIONS changed
    // corrects itself; what this prevents is a stale height being trusted for a
    // row that never mounts.
    getItemKey: (index) => links[index * columns]?.path ?? index,
    // A row is as tall as its tallest card, so a row with any tagged link in it
    // carries the chip line. `hasKnownTags` is the chip strip's own render test —
    // a tag id the map can't resolve renders no chip, so it must not buy the
    // taller estimate here either.
    estimateSize: (index) => {
      const rowLinks = links.slice(index * columns, index * columns + columns);
      const tagged = rowLinks.some((link) => hasKnownTags(link, tagsById));
      return Math.round(cardWidth * PREVIEW_ASPECT) + (tagged ? ESTIMATE_TAGGED : ESTIMATE_BARE);
    },
    overscan: 4,
  });

  // Changing `columns` re-composes every row, so the cached measurements now
  // describe rows that no longer exist (three cards' worth of height on a row that
  // holds two). `measure()` drops the cache wholesale; the visible rows re-measure
  // on their next layout. Also covers the once-per-mount DEFAULT_COLUMNS → real
  // correction, and the banner-height change that comes with a new `cardWidth`.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, columns, cardWidth]);

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
        // `scrollbar-gutter-stable` because this element's CONTENT WIDTH is read by
        // CODE — useElementWidth above measures the content box, which excludes the
        // scrollbar — and that number drives `columns` and `cardWidth`, which the
        // effect above turns into a wholesale `virtualizer.measure()`. So on a
        // classic-scrollbar platform a list that stops overflowing (a search
        // narrowed to a few hits, a short list, a bulk delete) widens this box by
        // 15px and can re-compose the whole grid at a different column count. That
        // is a re-layout, not a slide. list-layout.tsx carries the rest of the
        // note, including why both layouts must set this or neither.
        className="h-full scrollbar-gutter-stable overflow-y-auto p-4"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > SCROLL_TOP_THRESHOLD)}
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((virtualRow) => {
            const start = virtualRow.index * columns;
            const rowLinks = links.slice(start, start + columns);
            return (
              <div
                key={virtualRow.key}
                // The virtualizer MEASURES this element. `items-start` overrides the
                // grid's default stretch so each card is only as tall as its own
                // content: the row is still the height of its tallest card, so one
                // number still describes it, but the difference now falls OUTSIDE
                // the shorter cards as gutter instead of inside their borders as
                // dead space. Stretched, a card that used neither the title's second
                // line nor the chip strip enclosed up to ~60px of nothing while its
                // neighbour used both — and the border drew a box around it.
                // `data-index`
                // maps an observer entry back to a row (react-virtual's default
                // `indexAttribute`); the style deliberately carries no `height`,
                // which would be read back as the measurement and pin every row to
                // one shape. `pb-4` is the 16px row gutter, inside the measured box.
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute inset-x-0 grid items-start gap-4 pb-4"
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {rowLinks.map((link, cardIndex) => {
                  const index = start + cardIndex;
                  const pinned = index < pinnedCount;
                  // Needed twice below — as the card's text and as its tooltip.
                  const title = link.title || displayUrl(link.url);
                  const selected = bulkEditing && selectedLinks.has(link.path);
                  return (
                    <div
                      key={link.path}
                      className={`relative mx-auto flex w-full max-w-105 flex-col overflow-hidden rounded-lg border border-border ${
                        selected ? 'bg-muted' : 'hover:bg-muted/50'
                      }`}
                    >
                      <LinkPreviewImage
                        link={link}
                        className="aspect-12/7 w-full shrink-0"
                        fallback="panel"
                      />
                      <div className="flex min-w-0 flex-col gap-2 p-3">
                        <div className="flex items-center gap-2">
                          {/* text-base, the size the TITLE reads at — the same pairing
                              list-layout makes at its own text-sm. The host is the
                              second thing read, not a caption; it stays subordinate on
                              colour and weight rather than on size, and a card has MORE
                              room per link than a dense row, so a card can't be the
                              layout that shrinks it. It also puts the size-4 favicon at
                              list-layout's proportion — the mark matches the font size
                              there (14/14) as it does here (16/16). Free of the row
                              height either way: this line is the ⋯ trigger's 32px box,
                              and a 16px string's line box is 24, so the estimates above
                              don't move for it. */}
                          <Favicon host={hostFromText(link.url)} className="size-4 shrink-0" />
                          <span className="truncate text-base text-muted-foreground">
                            {hostFromText(link.url)}
                          </span>
                          {/* Both islands below are `relative z-10`, which is what
                              lifts them clear of the title anchor's full-card
                              overlay (see it below): the badges so the note's
                              `title` tooltip is reachable at all, the ⋯ / checkbox
                              so its click lands on the button and not on the link.
                              Everything else on this line stays UNDER the overlay,
                              so a click on the host opens the link like the rest of
                              the card does. */}
                          {(pinned || link.note) && (
                            <span className="relative z-10 flex shrink-0 items-center gap-2">
                              {pinned && <PinnedBadge />}
                              {link.note && <NoteBadge note={link.note} />}
                            </span>
                          )}
                          <span className="relative z-10 ml-auto flex shrink-0">
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
                          </span>
                        </div>
                        {/* One anchor for the whole card: `after:inset-0` stretches
                            an invisible overlay across the card (the card is the
                            `relative` ancestor), so a click anywhere that isn't one
                            of the islands above opens the link — which is how a
                            card grid is expected to behave, and how bracemark-expo's
                            card already behaves (its whole cell is one Pressable).
                            The buttons stay OUTSIDE the anchor in the DOM, which is
                            the rule they exist for (LinkRowMenu, and the chips
                            below); the overlay is what re-unites the two halves
                            visually. The clamp sits on the inner span, not on the
                            anchor: `line-clamp-2` is `-webkit-box`, and an
                            absolutely-positioned pseudo-element inside one is at
                            the mercy of the clamp's line counting.

                            `title` on the anchor discloses the full string that
                            line-clamp-2 hides past two lines (list-layout.tsx —
                            same reasoning, same pointer-only caveat). It answers
                            for the whole card now, since the overlay is what the
                            pointer is over. */}
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noreferrer"
                          title={title}
                          className="block after:absolute after:inset-0"
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
                          <span className="line-clamp-2 text-base font-medium">{title}</span>
                        </a>
                      </div>
                      {/* The chips are buttons, so they sit outside the anchor as
                          the card's bottom block — and above its overlay, or they
                          would be unclickable. One line, LinkTagChips' default. */}
                      <LinkTagChips
                        link={link}
                        tagsById={tagsById}
                        className="relative z-10 px-3 pb-3"
                      />
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
