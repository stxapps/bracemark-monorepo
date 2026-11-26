'use client';

// Dense one-row-per-link layout (the default). Window-virtualized with
// @tanstack/react-virtual: only the rows in view are mounted, so a large library
// scrolls cheaply. `ShowMore` lives outside the virtual measurement, below the
// rows, growing the page on click.

import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Folder } from 'lucide-react';

import {
  chipStripHeight,
  displayUrl,
  fitChips,
  hostFromText,
  type ListOptions,
  openableUrl,
  TAG_CHIP_METRICS,
} from '@stxapps/shared';
import { type LinkView, useSettings } from '@stxapps/web-react';
import { useElementWidth } from '@stxapps/web-ui/hooks/use-element-size';

import { useLinksPage } from '../_contexts/page-provider';
import { useLinksViewState } from '../_contexts/view-state-provider';
import { RelativeTime } from './relative-time';
import {
  addressText,
  EmptyState,
  Favicon,
  hasKnownTags,
  KeptCopyBadge,
  type LinkLayoutProps,
  LinkPreviewImage,
  LinkRowMenu,
  LinkRowSelect,
  LinkTagChips,
  listNameFor,
  measureRowHeight,
  NoteBadge,
  PinnedBadge,
  RefreshPill,
  remeasureAll,
  rowDate,
  ShowMore,
  TITLE_CLAMP,
  useListNameMap,
  useReportDisplayedLinkPaths,
  useRestoreReturnRow,
  useScrollTopOnQuery,
  useTagMap,
} from './shared';

// Row heights are MEASURED, not budgeted. The title is clamped (two lines by
// default; the `titleLines` option — docs/link-layouts.md), so a row's
// height turns on whether that title wraps — and whether it wraps is a fact about
// the browser's line breaker at the current pane width, font and root font size,
// not something derivable from the link. So each row reports its own height:
// `ref={virtualizer.measureElement}` and `data-index` on the row below, and no
// `height` in its style.
//
// `py-3.5` makes the 14px gutter explicit — every row is 14 + content + 14 (+1px
// border) whatever the content does — which is the whole point of measuring. The
// shapes that produces at the default options:
//
//    71 = 14 + [ title 20 + 2 + host 20 ]                        + 14 + 1
//    91 = 14 + [ title 40 + 2 + host 20 ]                        + 14 + 1
//   107 = 14 + [ title 20 + 2 + host 20 + 12 + one chip line 24 ] + 14 + 1
//   127 = 14 + [ title 40 + 2 + host 20 + 12 + one chip line 24 ] + 14 + 1
//
// and the options move them in whole lines: each title line is 20, each extra tag
// line 24 + the strip's 4 gap, and an address line with nothing on it (address
// `none`, no list name, no badge) drops its 2 + 20. The thumbnail never sets the
// height: it is 2 + 40 = 42, the shortest text column there is (estimateRow).
//
// A FIXED budget cannot have that gutter once the title may take two lines: it
// would reserve the second line on every row and leave 20px of slack on the rows
// that don't use it. That slack either splits (centred content — the thumbnail
// rail then wanders row to row) or falls at the bottom (top-aligned — the gap
// between rows then alternates 29/49). Measuring leaves no slack to place.
//
// Two things keep the measurement settling in ONE pass rather than oscillating:
// the chip strip is capped at the `tagLines` option and MEASURED before paint
// (LinkTagChips' layout effect, overflow behind "+N"), so its height is final by the
// time the row is measured; and the 64x40 preview is a fixed slot, so a late image
// load can't reflow a row either.
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
//
// estimateRow below builds the estimate from those same parts. Each guess sits
// halfway between its outcomes: a title capped at N lines is guessed at
// (1 + N) / 2 of them, and the tag strip at the lines the shared chip-fit
// arithmetic expects at this pane's width (@stxapps/shared fitChips — the one
// bracemark-expo renders from). At the default options it lands where the two
// constants this file used to carry did: 81 for an untagged row (was 80), 117 for
// a tagged one (was 116).
const GUTTER = 14 + 14 + 1;
const TITLE_LINE = 20;
const ADDRESS_LINE = 2 + 20;
const THUMBNAIL = 2 + 40;
const STRIP_GAP = 12;
// What the row spends beside the text column — pl-4 + pr-2, the ⋯ menu's 32 + its
// gap-3, the thumbnail's 64 + gap-3, the date column (~60 + gap-3) — for the chip
// estimate's width. An estimate: overstate the chrome and the guess errs a line
// tall, which a measured row corrects on mount.
const ROW_CHROME = 16 + 8 + 44;
const THUMBNAIL_CHROME = 76;
const DATE_CHROME = 72;
// The `@xl` container width the date column appears at (36rem at a 16px root).
const DATE_MIN_PANE = 576;

// No per-line ceiling here: web measures, and its strip is bounded by lines alone.
const WEB_CHIP_METRICS = { ...TAG_CHIP_METRICS, maxPerLine: Infinity };

function estimateRow(
  link: LinkView,
  pinned: boolean,
  options: ListOptions,
  tagsById: Map<string, string>,
  stripWidth: number,
): number {
  const { fields } = options;
  let text = TITLE_LINE * ((1 + options.titleLines) / 2);
  const badges =
    pinned ||
    (fields.note && !!link.note) ||
    (fields.keptCopy && !!(link.readModeId || link.screenshotId));
  if (fields.address !== 'none' || fields.listName || badges) text += ADDRESS_LINE;
  if (fields.tags && hasKnownTags(link, tagsById)) {
    const names = link.tagIds.flatMap((id) => tagsById.get(id) ?? []);
    // Before the pane is measured the width is 0: guess halfway to the cap.
    const height =
      stripWidth > 0
        ? chipStripHeight(fitChips(names, stripWidth, options.tagLines, 1, WEB_CHIP_METRICS))
        : 24 + ((options.tagLines - 1) / 2) * (24 + TAG_CHIP_METRICS.gap);
    text += STRIP_GAP + height;
  }
  return GUTTER + Math.max(text, fields.image ? THUMBNAIL : 0);
}

// Past this many pixels we treat the pane as "scrolled away from the top", so a
// background sync is staged behind the refresh pill (see view-state-provider).
const SCROLL_TOP_THRESHOLD = 8;

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
  // The scroll container as STATE as well as a ref: useElementWidth needs to see it
  // mount (the div is absent while EmptyState shows), and the tag estimate needs the
  // pane width. The virtualizer and the scroll helpers read the ref.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const paneWidth = useElementWidth(scrollEl);
  const { setScrolled, bulkEditing, selectedLinks, toggleSelected, selectRange } =
    useLinksViewState();
  const tagsById = useTagMap();
  const listNames = useListNameMap();
  const { selection } = useLinksPage();
  // This layout's display options (docs/link-layouts.md). The date column shows the
  // `date` option's field — by default the one the rows are SORTED by, so its
  // relative values read top-to-bottom in order (rowDate).
  const options = useSettings().layoutOptions.list;
  const { fields } = options;
  const showDateColumn = fields.date !== 'none' && paneWidth >= DATE_MIN_PANE;
  const stripWidth =
    paneWidth > 0
      ? paneWidth -
        ROW_CHROME -
        (fields.image ? THUMBNAIL_CHROME : 0) -
        (showDateColumn ? DATE_CHROME : 0)
      : 0;

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
      estimateRow(links[index], index < pinnedCount, options, tagsById, stripWidth),
    overscan: 8,
    measureElement: measureRowHeight,
  });

  // An option change reshapes rows that are already MEASURED — a title clamp, a tag
  // cap, a field coming or going — and the size cache keeps their old heights until
  // each remounts. Drop it, so every row is re-estimated and the mounted ones
  // re-measured at once. Keyed on the options' VALUE: the object is rebuilt whenever
  // a settings file re-emits.
  const optionsKey = JSON.stringify(options);
  useEffect(() => {
    remeasureAll(virtualizer, scrollRef.current);
  }, [virtualizer, optionsKey]);

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

  // Coming back from the reader: page to the row it was opened from and put it in
  // view, once (see the hook). The scroller exists only while there are rows.
  useRestoreReturnRow({
    links,
    isLoading,
    hasMore,
    showMore,
    ready: links.length > 0,
    getScrollElement: () => scrollRef.current,
    scrollToLink: (index) => virtualizer.scrollToIndex(index, { align: 'center' }),
  });

  if (links.length === 0) return <EmptyState isLoading={isLoading} variant="list" />;

  return (
    <div className="relative h-full">
      <RefreshPill show={hasPending} onClick={applyAndScrollTop} />
      <div
        ref={(el) => {
          scrollRef.current = el;
          setScrollEl(el);
        }}
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
        // just one of them makes the Settings → Appearance layout switch shift the pane.
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
            const address = addressText(link, fields.address);
            const listName = listNameFor(link, fields.listName, listNames, selection);
            const showNote = fields.note && !!link.note;
            const showKept = fields.keptCopy && !!(link.readModeId || link.screenshotId);
            // The address line holds the address, the list name and the badges, so it
            // goes only when ALL of them do — a pinned row with address `none` still
            // needs a line for its pin.
            const showAddressLine = !!address || !!listName || pinned || showNote || showKept;
            const date = rowDate(link, fields.date, sortOn);
            // Undefined for a url nothing can open (url/url.ts) — both anchors
            // then render without an href, so the row shows the link but no
            // longer offers a click that does nothing.
            const href = openableUrl(link.url);
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
                //
                // `has-[a:active]`, not `active:`: a press anywhere inside lights
                // `:active` up the whole ancestor chain, so a bare `active:` would
                // wash the row for a tap on its tag chip or its ⋯ menu, which are
                // not this row's action. In bulk edit the row IS the action.
                className={`absolute inset-x-0 flex items-center gap-3 border-b border-border py-3.5 pr-2 pl-4 ${
                  selected ? 'bg-muted' : 'hover:bg-muted/50 has-[a:active]:bg-muted'
                } ${bulkEditing ? 'cursor-pointer select-none active:bg-muted' : ''}`}
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
                  {/* The `image` field: off, the thumbnail column goes and the text
                      starts at the row's edge. */}
                  {fields.image && (
                    <a
                      href={href}
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
                  )}
                  <span className="min-w-0 flex-1">
                    <a
                      href={href}
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
                          text.)

                          `dir="auto"`: the title is the page's text, in whatever
                          script it was written, inside an LTR app. Without it an
                          Arabic title is laid out as an LTR paragraph, so its
                          opening words land at the far left — the END for its
                          reader. `wrap-anywhere`: a title that is the url fallback,
                          or one unbroken word, has no break opportunity, and the
                          clamp's overflow-hidden would clip the first line mid-
                          segment with no ellipsis. It breaks only where nothing
                          else can. */}
                      <span
                        dir="auto"
                        className={`${TITLE_CLAMP[options.titleLines]} text-sm font-medium wrap-anywhere`}
                        title={title}
                      >
                        {title}
                      </span>
                      {/* text-sm, matching the title's size — the host is the second
                          thing read, not a caption. mt-0.5 keeps the two lines from
                          touching. size-3.5 leaves the favicon a touch under the
                          14px cap height so it reads as a mark, not a third word;
                          the line box is 20 either way. */}
                      {showAddressLine && (
                        <span className="mt-0.5 flex items-center gap-1.5">
                          {address && (
                            <>
                              <Favicon
                                host={hostFromText(link.url)}
                                className="size-3.5 shrink-0"
                              />
                              {/* `dir="ltr"`: an address reads left to right in every script. */}
                              <span dir="ltr" className="truncate text-sm text-muted-foreground">
                                {address}
                              </span>
                            </>
                          )}
                          {/* The list name (the `listName` field): TEXT, not a button —
                            it rides this line inside the row's anchor, where a button
                            may not nest; the sidebar is the way to the list. Capped at
                            half the line so a long name can't push the address out. */}
                          {listName && (
                            <span className="flex max-w-1/2 min-w-0 shrink-0 items-center gap-1 text-sm text-muted-foreground">
                              <Folder className="size-3.5 shrink-0" aria-label="List" />
                              <span dir="auto" className="truncate">
                                {listName}
                              </span>
                            </span>
                          )}
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
                          {showNote && <NoteBadge note={link.note ?? ''} />}
                          {showKept && <KeptCopyBadge link={link} />}
                        </span>
                      )}
                    </a>
                    {fields.tags && (
                      <LinkTagChips
                        link={link}
                        tagsById={tagsById}
                        maxLines={options.tagLines}
                        className="mt-3"
                      />
                    )}
                  </span>
                </div>
                {/* Sorted-field date column — only when the PANE is wide enough (@xl
                    container width), so it never crowds the title on a narrow pane
                    or in the browser extension's popup. Shows the createdAt/updatedAt value the
                    rows are ordered by (see dateVerb above). dateTime carries the exact
                    instant; title/aria-label prefix the verb so the field is legible
                    to hover and AT (the bare visible text can't say which it is). */}
                {date && (
                  <RelativeTime
                    epochMs={date.epochMs}
                    verb={date.verb}
                    className="hidden shrink-0 @xl:block"
                  />
                )}
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
