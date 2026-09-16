'use client';

// Dense one-row-per-link layout (the default). Window-virtualized with
// @tanstack/react-virtual: only the rows in view are mounted, so a large library
// scrolls cheaply. `ShowMore` lives outside the virtual measurement, below the
// rows, growing the page on click.

import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { displayUrl, hostFromText } from '@stxapps/shared';

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

// Row heights are MEASURED, not budgeted. The title is `line-clamp-2`, so a row's
// height turns on whether that title wraps — and whether it wraps is a fact about
// the browser's line breaker at the current pane width, font and root font size,
// not something derivable from the link. So each row reports its own height:
// `ref={virtualizer.measureElement}` and `data-index` on the row below, and no
// `height` in its style.
//
// `py-3.5` makes the 14px gutter explicit — every row is 14 + content + 14 (+1px
// border) whatever the content does — which is the whole point of measuring. The
// four shapes that produces:
//
//    71 = 14 + [ title 20 + 2 + host 20 ]                        + 14 + 1
//    91 = 14 + [ title 40 + 2 + host 20 ]                        + 14 + 1
//   107 = 14 + [ title 20 + 2 + host 20 + 12 + one chip line 24 ] + 14 + 1
//   127 = 14 + [ title 40 + 2 + host 20 + 12 + one chip line 24 ] + 14 + 1
//
// A FIXED budget cannot have that gutter once the title may take two lines: it
// would reserve the second line on every row and leave 20px of slack on the rows
// that don't use it. That slack either splits (centred content — the thumbnail
// rail then wanders row to row) or falls at the bottom (top-aligned — the gap
// between rows then alternates 29/49). Measuring leaves no slack to place.
//
// Two things keep the measurement settling in ONE pass rather than oscillating:
// the chip line is capped at one (LinkTagChips' default `maxLines` — measured,
// overflow behind "+N"), and the 64x40 preview is a fixed slot, so neither the tag
// strip nor a late image load can reflow a row after it has been measured.
//
// The numbers below are only ESTIMATES, for rows not yet mounted. Each sits
// BETWEEN its own two outcomes rather than at the floor, so the error cancels
// across a long list instead of accumulating in one direction.
//
// What measuring costs: `getTotalSize()` is part measurement, part estimate, so
// the scrollbar thumb resizes as unmeasured rows scroll into view. That is a
// second-order wobble here — infinite scroll (below) already grows `count` as you
// near the bottom, so this list's total was never stable. react-virtual
// compensates the scroll offset on an item's FIRST measurement in either
// direction and skips the compensation when re-measuring during a backward
// scroll, which is what stops the correction cascading as you scroll up.
//
// What it buys, besides the gutter: the row cannot disagree with what it
// rendered. The fixed budgets had to be kept in step with the markup by hand, and
// had to be scaled by the root font size (useRootFontScale) because they were px
// numbers against an all-rem row — an approximation that erred generous on
// purpose. A measured row is simply correct at any root size, and that whole
// apparatus (the scale, the ceil, the re-measure effect) is gone with it.
//
// Sizes cache by `getItemKey`, which is why the virtualizer is handed the link
// PATH rather than the default index: a search or a re-sort moves a link to a
// different index, and a height cached by index would then describe whichever
// link used to sit there. Keyed by path, a measured height follows its link, and
// no manual invalidation is needed — a row that changes shape while mounted is
// re-measured by the observer, and one that changes while offscreen is measured
// afresh when it mounts.
const ESTIMATE_BARE = 80;
const ESTIMATE_TAGGED = 116;

// Past this many pixels we treat the pane as "scrolled away from the top", so a
// background sync is staged behind the refresh pill (see view-state-provider).
const SCROLL_TOP_THRESHOLD = 8;

// Compact, localized "N ago" for the wide-pane date column (the sorted field —
// created or updated; the row supplies the verb). Intl.RelativeTimeFormat
// only formats a (count, unit) pair, so we pick the largest unit that fits and hand it the
// count; `numeric: 'auto'` yields "yesterday"/"last week" where they read better than
// "1 … ago", and `style: 'short'` keeps the column narrow ("3 days ago", "2 mo. ago").
const relativeTimeFormat = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
  style: 'short',
});
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];
function formatRelativeTime(epochMs: number): string {
  const diff = epochMs - Date.now(); // < 0 for the past
  const abs = Math.abs(diff);
  for (const [unit, ms] of RELATIVE_UNITS) {
    if (abs >= ms) return relativeTimeFormat.format(Math.round(diff / ms), unit);
  }
  return relativeTimeFormat.format(Math.round(diff / 1000), 'second');
}

export function ListLayout({
  links,
  sortOn,
  pinnedCount,
  hasMore,
  showMore,
  isLoading,
  hasPending,
  applyPending,
}: LinkLayoutProps) {
  // The date column shows the field the rows are SORTED by, so the relative values
  // read top-to-bottom in order — showing createdAt while sorted by updatedAt would
  // look out of order. The verb names which instant it is (the visible text is bare
  // to keep the column narrow, so "Added"/"Updated" rides the title + aria-label).
  const dateVerb = sortOn === 'createdAt' ? 'Added' : 'Updated';
  const scrollRef = useRef<HTMLDivElement>(null);
  const { setScrolled, bulkEditing, selectedLinks, toggleSelected, selectRange } =
    useLinksViewState();
  const tagsById = useTagMap();

  // This layout owns the scroll position; reset the shared flag on mount (fresh
  // at top) and unmount (so a layout switch doesn't leave it stuck true).
  useEffect(() => {
    setScrolled(false);
    return () => setScrolled(false);
  }, [setScrolled]);

  // ...and put it back at the top whenever the VIEW changes — this component
  // stays mounted across a sidebar pick, a committed search or a sort change, so
  // nothing else would (see the hook for why the offset can't just be left).
  useScrollTopOnQuery(() => scrollRef.current);

  const applyAndScrollTop = () => {
    applyPending();
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const virtualizer = useVirtualizer({
    count: links.length,
    getScrollElement: () => scrollRef.current,
    // By path, not the default index — see the note above the estimates.
    getItemKey: (index) => links[index]?.path ?? index,
    estimateSize: (index) =>
      hasKnownTags(links[index], tagsById) ? ESTIMATE_TAGGED : ESTIMATE_BARE,
    overscan: 8,
  });

  // Report only the displayed rows (index maps 1:1 to `links`) so extraction tracks the window.
  const rows = virtualizer.getVirtualItems();
  useReportDisplayedLinkPaths(
    links,
    rows.length ? rows[0].index : 0,
    rows.length ? rows[rows.length - 1].index : -1,
  );

  // Infinite scroll: grow the page automatically as the bottom row comes within
  // `overscan` of the viewport (the last virtualized index reaches the end).
  // `ShowMore` below stays as the keyboard/AT fallback and the "there's more" cue.
  // `showMore` grows `limit` by a fixed step per call and `rows` is a fresh array
  // every render, so we gate on the loaded count: fire once per page, re-arm only
  // once the next page's rows actually land (`links.length` changes).
  const autoLoadedLengthRef = useRef(-1);
  useEffect(() => {
    if (!hasMore) return;
    const last = rows[rows.length - 1];
    if (last && last.index >= links.length - 1 && autoLoadedLengthRef.current !== links.length) {
      autoLoadedLengthRef.current = links.length;
      showMore();
    }
  }, [rows, hasMore, links.length, showMore]);

  if (links.length === 0) return <EmptyState isLoading={isLoading} variant="list" />;

  return (
    <div className="relative h-full">
      <RefreshPill show={hasPending} onClick={applyAndScrollTop} />
      <div
        ref={scrollRef}
        // `@container` so the date column below can gate on the PANE width (not the
        // viewport) — the pane widens/narrows with the collapsible sidebar without a
        // window resize, so a viewport `lg:` breakpoint would be wrong here.
        //
        // `scrollbar-gutter-stable` is what keeps that container width from moving
        // with the SCROLLBAR as well. On a classic-scrollbar platform the content
        // box is 15px narrower while this pane overflows, so a list that stops
        // overflowing — a search narrowed to three hits, a short list, a bulk
        // delete — widens it by 15px, and across the `@xl` threshold that adds or
        // removes the date column outright. Reserved, the number is constant.
        //
        // card-layout.tsx pins its own scroller for the same reason (there the 15px
        // moves the column count), and the two must carry this TOGETHER: they are
        // sibling scrollers for one pane with only ever one mounted, so a gutter on
        // just one of them makes the Settings → Misc layout switch shift the pane.
        // Not in conflict with the frame's `data-no-scrollbar-gutter` (page.tsx) —
        // that opt-out is `html`'s dead gutter, outside a pane that has its own
        // scrollbar; this is that pane. docs/safe-area.md carries the full note.
        className="@container h-full scrollbar-gutter-stable overflow-y-auto"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > SCROLL_TOP_THRESHOLD)}
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((row) => {
            const link = links[row.index];
            const pinned = row.index < pinnedCount;
            // Needed twice below — as the row's text and as its `title` tooltip.
            const title = link.title || displayUrl(link.url);
            const selected = bulkEditing && selectedLinks.has(link.path);
            // In bulk-edit mode a click toggles selection instead of opening the
            // link; shift-click extends a range over `links` (the displayed
            // order). The ROW owns that click rather than the two anchors below,
            // because everything that is neither of them is row surface too — the
            // `py-3.5` gutters, the `gap-3` columns, the space under the thumbnail
            // on a two-line row, the tag strip and the gaps between its pills, the
            // date column, the `pr-2` the ⋯ menu vacates. Hung on the anchors, the
            // mode's one gesture missed on all of it; hung here there is no dead
            // pixel left to miss. card-layout reaches the same rule through its
            // title anchor's full-card overlay (it has one; a dense row doesn't),
            // and bracemark-expo's row is literally one Pressable.
            //
            // What that costs is one rule for everything interactive inside the
            // row: it must not toggle a second time on the way up. LinkRowSelect
            // stops its click, LinkTagChips goes inert and clicks through, and the
            // anchors here only cancel their own navigation.
            //
            // Middle-click still opens the link — that is `auxclick`, which never
            // reaches an onClick handler. Cmd/ctrl-click does NOT: it arrives as an
            // ordinary click, and the unconditional preventDefault on the anchors
            // cancels the new-tab navigation, so it toggles like a plain click.
            const onRowClick = bulkEditing
              ? (e: React.MouseEvent) => {
                  if (e.shiftKey) selectRange(link, links);
                  else toggleSelected(link);
                }
              : undefined;
            const onAnchorClick = bulkEditing
              ? (e: React.MouseEvent) => e.preventDefault()
              : undefined;
            return (
              <div
                key={link.path}
                // The virtualizer MEASURES this element. `data-index` is how it maps
                // an observer entry back to a row (its default `indexAttribute`), and
                // the style deliberately carries no `height`: a fixed one would be
                // read back as the measurement, and the row could never grow to a
                // second title line. `py-3.5` is the 14px gutter the two fixed
                // budgets used to produce implicitly by centring content inside a
                // fixed height — explicit, it holds on every row.
                ref={virtualizer.measureElement}
                data-index={row.index}
                // `cursor-pointer` because the row is clickable in this mode and
                // nothing else says so: styles.css opts every enabled button and
                // [role=button] into the pointer, and a div with an onClick is
                // neither, so the pointer appeared only over the anchors and the
                // checkbox — the parts that were ALREADY clickable before this
                // mode existed. The rest of the row toggled while looking inert,
                // which is the same lie the dead zones told, one layer up.
                // card-layout gets it free: its whole surface is an <a>'s overlay.
                //
                // The row does NOT take `role="checkbox"` to earn the cursor
                // through that rule. LinkRowSelect is already a real checkbox
                // inside this row, so a role here would put two checkboxes in the
                // AT tree for one selection. (bracemark-expo's row CAN declare the
                // role — Pressable is `accessible`, so it collapses its inner
                // checkbox into itself instead of doubling it. link-row.tsx.) The
                // row's click stays a pointer-only enhancement; the checkbox is
                // the keyboard and screen-reader path, as it was.
                //
                // `select-none` because the mode's own gesture produces the mess:
                // shift-click extends the browser's text selection from the last
                // click, so range-selecting rows paints highlight across every
                // title and host it passes. A drag that means "select these rows"
                // shouldn't leave text selected instead.
                className={`absolute inset-x-0 flex items-center gap-3 border-b border-border py-3.5 pr-2 pl-4 ${
                  selected ? 'bg-muted' : 'hover:bg-muted/50'
                } ${bulkEditing ? 'cursor-pointer select-none' : ''}`}
                style={{ transform: `translateY(${row.start}px)` }}
                onClick={onRowClick}
              >
                {/* Bulk-edit selection sits at the row's LEADING edge (a scannable
                    checkbox column), pushing the image/text right; the row menu is
                    hidden while selecting. The thumbnail stays — it's the row's
                    at-a-glance identity — so the checkbox is inserted, not swapped in. */}
                {bulkEditing && <LinkRowSelect link={link} links={links} />}
                {/* Thumbnail + text share a TOP edge, which is why they get their
                    own `items-start` box instead of sitting directly in the row.
                    The row stays `items-center` so the date and the ⋯ menu still
                    centre; this box is what centres inside it, and its contents
                    align to its top. Centring the thumbnail against the text
                    column read fine when every row was one shape, but the column
                    now runs 42 to 98 tall depending on the title's line count and
                    the chips, which would put the image anywhere from 1px to 29px
                    below the title — so the left rail would wander as you scrolled
                    a mixed list. Top-aligned, the image and the title start on the
                    same line in every row, which together with the row's `py-3.5`
                    puts every thumbnail at the same offset from its row's top.

                    Two sibling anchors (image, text) rather than one wrapping the
                    whole row: the tag chips are buttons and may not nest inside an
                    <a> (same rule as LinkRowMenu), so the chips sit in the text
                    column AFTER its anchor. The image anchor duplicates the text
                    one, so keyboard/AT skip it. */}
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noreferrer"
                    tabIndex={-1}
                    aria-hidden
                    className="shrink-0"
                    onClick={onAnchorClick}
                  >
                    {/* mt-0.5 pays back the title's half-leading. `items-start`
                        aligns the image's box to the TEXT BOX's top, but a 14px
                        Inter glyph in a 20px line box starts ~1.5px below that
                        edge, so a flush image reads as sitting high. 2 is the
                        largest honest nudge: it lands the image on the text's
                        first pixel of ink-bearing box and leaves its bottom
                        exactly level with the shortest text column there is
                        (2+40 = 42 = 20+2+20, a one-line title with no chips), so
                        the image never sets the row height in any of the four
                        shapes. Chasing Inter's cap height instead would want ~5
                        and make the image the tallest thing in the shortest row.
                        In rem, so it scales with the text. */}
                    <LinkPreviewImage
                      link={link}
                      className="mt-0.5 h-10 w-16 rounded"
                      iconClassName="size-4 rounded"
                    />
                  </a>
                  <span className="min-w-0 flex-1">
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block min-w-0"
                      onClick={onAnchorClick}
                    >
                      {/* The title line holds the title ALONE — no badges, so a
                          narrow pane spends every pixel it has on the one string
                          that identifies the link. TWO lines before it truncates,
                          which is what the measured row height above exists to
                          allow: a narrow pane (the browser extension's popup above
                          all) fits only a few words per line, and one line there
                          cuts most titles mid-phrase. A short title still occupies
                          one line and its row stays 71 tall, so the second line
                          costs nothing on the rows that don't need it.

                          `line-clamp-2` rather than `truncate` + a fixed height:
                          the clamp is a MAXIMUM, so nothing has to predict whether
                          this particular string wraps. (It brings its own
                          `-webkit-box` display, so the `block` that `truncate`
                          needed is gone.)

                          `title` is still the only disclosure of the remainder past
                          two lines. Hover-only, so it's a pointer affordance; on
                          touch the row menu's editor is the path. (bracemark-expo
                          has no equivalent and needs none: RN has no tooltip, and
                          `numberOfLines` truncates the PAINT, not the accessible
                          text.) */}
                      <span className="line-clamp-2 text-sm font-medium" title={title}>
                        {title}
                      </span>
                      {/* text-sm, matching the title's size — the host is the second
                          thing read, not a caption. mt-0.5 keeps the two lines from
                          touching. size-3.5 leaves the favicon a touch under the
                          14px cap height so it reads as a mark, not a third word;
                          the line box is 20 either way. */}
                      <span className="mt-0.5 flex items-center gap-1.5">
                        <Favicon host={hostFromText(link.url)} className="size-3.5 shrink-0" />
                        <span className="truncate text-sm text-muted-foreground">
                          {hostFromText(link.url)}
                        </span>
                        {/* The badges ride THIS line, not the title's, in all
                            four layouts (both here and in bracemark-expo, list
                            and card alike — the card had no title-adjacent slot
                            anyway, so this is where the two converge). A host
                            string is bounded at ~15-25 chars where a title is
                            unbounded, so this line has slack the title line
                            doesn't, and the badges cost the reader nothing here.
                            They are 14px inside a 20px line box, so the row's
                            height doesn't move for them.

                            Not the title's line: the title is the string a narrow
                            pane has least room for, and it now runs to two lines,
                            so a badge there would compete with it twice over. Not
                            the tag-chip row either — that doesn't render at all
                            for an untagged link, so a pinned untagged row would
                            have to grow a whole 24px chip line to hold one glyph.

                            Still inside the anchor, so their aria-labels stay
                            part of the link's accessible name (now read after
                            the host rather than after the title). */}
                        {pinned && <PinnedBadge />}
                        {link.note && <NoteBadge note={link.note} />}
                      </span>
                    </a>
                    <LinkTagChips link={link} tagsById={tagsById} className="mt-3" />
                  </span>
                </div>
                {/* Sorted-field date column — only when the PANE is wide enough (@xl
                    container width), so it never crowds the title on a narrow pane
                    or in the extension popup. Shows the createdAt/updatedAt value the
                    rows are ordered by (see dateVerb above). dateTime carries the exact
                    instant; title/aria-label prefix the verb so the field is legible
                    to hover and AT (the bare visible text can't say which it is). */}
                <time
                  dateTime={new Date(link[sortOn]).toISOString()}
                  title={`${dateVerb} ${new Date(link[sortOn]).toLocaleString()}`}
                  aria-label={`${dateVerb} ${formatRelativeTime(link[sortOn])}`}
                  className="hidden shrink-0 text-xs whitespace-nowrap text-muted-foreground @xl:block"
                >
                  {formatRelativeTime(link[sortOn])}
                </time>
                {!bulkEditing && (
                  <LinkRowMenu
                    link={link}
                    pinned={pinned}
                    pinnedAbove={row.index > 0 && pinned ? links[row.index - 1] : undefined}
                    pinnedBelow={row.index < pinnedCount - 1 ? links[row.index + 1] : undefined}
                  />
                )}
              </div>
            );
          })}
        </div>
        <ShowMore hasMore={hasMore} showMore={showMore} />
      </div>
    </div>
  );
}
