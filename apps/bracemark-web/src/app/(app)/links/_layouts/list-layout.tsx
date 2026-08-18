'use client';

// Dense one-row-per-link layout (the default). Window-virtualized with
// @tanstack/react-virtual: only the rows in view are mounted, so a large library
// scrolls cheaply. `ShowMore` lives outside the virtual measurement, below the
// rows, growing the page on click.

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { displayUrl, hostFromText } from '@stxapps/shared';
import { type LinkView } from '@stxapps/web-react';
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

// TWO fixed row budgets, picked per row by whether the link has a tag the tag
// map knows — which is exactly the test LinkTagChips applies before it renders
// anything, so the two must not drift. `hasKnownTags` below is the only copy;
// a plain `tagIds.length > 0` would be subtly wrong, giving the tall row to a
// link whose only tag was deleted or hasn't synced yet and then leaving a hole
// where the chips would have gone.
//
//   bare    70 = 14 + [ title 20 + 2 + host 20 ]                        + 14
//   tagged 106 = 14 + [ title 20 + 2 + host 20 + 12 + one chip line 24 ] + 14
//
// The chip line is LinkTagChips' default `maxLines` — measured, overflow behind
// "+N" — so it can never become two, which is what keeps the tagged number a
// constant rather than something to measure. The 64×40 preview image on the
// left, nudged down 0.5 to sit level with the title's ink, ends exactly level
// with the bare text column and well short of the tagged one, so it never sets
// the height either way. One
// budget used to serve both, which meant untagged rows paid for a chip line
// they don't render; that slack is the whole reason there are two numbers.
//
// Both are pure functions of the DATA, never of the DOM: no `measureElement`,
// no ref on the row, so the virtualizer's total size stays exact and the
// scrollbar never settles as you scroll. The price is that react-virtual caches
// measurements by index and will NOT re-run `estimateSize` on its own when a
// row changes shape — see the re-measure effect below.
//
// The budgets are in px but EVERY part of the row they measure is rem: Tailwind v4
// sizes text from `--text-sm`/`--text-xs` (0.875/0.75rem) AND spacing from
// `--spacing: 0.25rem`, so `h-10`, `gap-3`, `pl-4` are rem as well. Nothing here
// is px except the 1px `border-b`. Since this app pins no root `font-size`, a
// reader who raises the browser's default font-size preference grows the whole
// row — while these numbers would not, and the rows are ABSOLUTELY POSITIONED
// with no `overflow-hidden`, so the overflow lands on top of the next row
// rather than clipping.
//
// Hence a UNIFORM scale by the root font size (useRootFontScale) rather than a
// fixed/text split: on the web there is no meaningfully unscaled part. (The
// native card in bracemark-expo does split, and correctly — RN has no rem, Uniwind
// resolves spacing to fixed dp, and the OS font scale multiplies fontSize
// ALONE. Same-looking budget, genuinely different arithmetic.) The 1px border
// rides along in the scale; erring 0.5px generous beats the pedantry.
//
// Note this is NOT browser zoom, which scales px and rem alike.
const ROW_HEIGHT_BARE = 70;
const ROW_HEIGHT_TAGGED = 106;

// The row-height predicate, and LinkTagChips' render test, in one place: a tag
// id the map doesn't resolve is skipped there and must not buy a taller row here.
const hasKnownTags = (link: LinkView, tagsById: Map<string, string>) =>
  link.tagIds.some((id) => tagsById.has(id));

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
  // Ceil so rounding can only ever give the content MORE room, never less.
  const fontScale = useRootFontScale();
  const bareHeight = Math.ceil(ROW_HEIGHT_BARE * fontScale);
  const taggedHeight = Math.ceil(ROW_HEIGHT_TAGGED * fontScale);

  // This layout owns the scroll position; reset the shared flag on mount (fresh
  // at top) and unmount (so a layout switch doesn't leave it stuck true).
  useEffect(() => {
    setScrolled(false);
    return () => setScrolled(false);
  }, [setScrolled]);

  const applyAndScrollTop = () => {
    applyPending();
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const virtualizer = useVirtualizer({
    count: links.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (hasKnownTags(links[index], tagsById) ? taggedHeight : bareHeight),
    overscan: 8,
  });

  // A changed `estimateSize` doesn't invalidate the cached measurements on its
  // own, so re-measure when the root font size moves (rare — a browser
  // preference change, plus the once-per-mount 1 → real correction) or when any
  // row crosses between the two budgets.
  //
  // The trigger is a SIGNATURE of which rows are tall, not `links` itself.
  // `useLiveQuery` hands back a fresh array on every `items` write, so keying on
  // it would call measure() every tick — and measure() notifies, so each tick
  // would cost a second render of the whole list (noticeably, while typing in
  // search). The signature only changes VALUE when a link actually gains or
  // loses a known tag, and the effect below compares it as the string it is.
  //
  // Memoized because building it is O(loaded) — a Map lookup per tag id, then a
  // string one char per link — while this component re-renders on every scroll
  // offset the virtualizer reports. Unmemoized, that is ~0.2ms and a few KB of
  // garbage per scroll FRAME at 5k loaded rows, growing without bound as
  // infinite scroll pages more in, to recompute a value that can only move when
  // the store writes. Both deps change identity exactly then and not on scroll:
  // `links` per liveQuery emit, `tagsById` per tag-tree emit (useTagMap memoizes
  // it). Nothing else in the render path is O(loaded) — react-virtual keeps its
  // own measurements memoized and binary-searches them, so this was the only
  // whole-list work on the scroll path.
  const tallSignature = useMemo(
    () => links.map((link) => (hasKnownTags(link, tagsById) ? 1 : 0)).join(''),
    [links, tagsById],
  );
  // BEFORE PAINT, not after. A row that just gained a tag renders its chips
  // inside the height the STALE measurement gives it, and the rows are
  // absolutely positioned with no `overflow-hidden` (that is what keeps a
  // font-size overflow from clipping, above), so a passive effect would show one
  // frame of chips lying over the next row and then a jump. Same frame, in the
  // other direction, for a row that lost its last tag. The trigger is rare — a
  // tag edit, or a sync landing one — but the fix costs a synchronous re-render
  // this commit rather than a second frame, which is the cheaper of the two.
  //
  // useLayoutEffect is safe HERE despite the SSR rule: bracemark-web is
  // `output: 'export'`, and at build-time prerender both AuthGuard ('loading')
  // and InitialSyncGate ('checking') render nothing, so nothing under (app)
  // reaches the server at all. LinkTagChips already measures in a layout effect
  // one level down for the same reason.
  useLayoutEffect(() => {
    virtualizer.measure();
  }, [virtualizer, bareHeight, taggedHeight, tallSignature]);

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
        className="@container h-full overflow-y-auto"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > SCROLL_TOP_THRESHOLD)}
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((row) => {
            const link = links[row.index];
            const pinned = row.index < pinnedCount;
            const selected = bulkEditing && selectedLinks.has(link.path);
            // In bulk-edit mode a click toggles selection instead of opening the
            // link (middle/cmd-click still opens); shift-click extends a range
            // over `links` (the displayed order). Shared by both row anchors.
            const onRowClick = bulkEditing
              ? (e: React.MouseEvent) => {
                e.preventDefault();
                if (e.shiftKey) selectRange(link, links);
                else toggleSelected(link);
              }
              : undefined;
            return (
              <div
                key={link.path}
                className={`absolute inset-x-0 flex items-center gap-3 border-b border-border pr-2 pl-4 ${selected ? 'bg-muted' : 'hover:bg-muted/50'
                  }`}
                style={{ height: row.size, transform: `translateY(${row.start}px)` }}
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
                    column read fine when every row was 70, but the two budgets
                    put it 19px below the title on a tagged row and 1px below on a
                    bare one — so the left rail wandered as you scrolled a mixed
                    list. Top-aligned, the image and the title start on the same
                    line in every row.

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
                    onClick={onRowClick}
                  >
                    {/* mt-0.5 pays back the title's half-leading. `items-start`
                        aligns the image's box to the TEXT BOX's top, but a 14px
                        Inter glyph in a 20px line box starts ~1.5px below that
                        edge, so a flush image reads as sitting high. 2 is the
                        largest honest nudge: it lands the image on the text's
                        first pixel of ink-bearing box and leaves its bottom
                        exactly level with the bare row's text column (2+40 = 42
                        = 20+2+20), so the image still never sets the height.
                        Chasing Inter's cap height instead would want ~5 and make
                        the image the tallest thing in a bare row. In rem, so it
                        scales with the row. */}
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
                      onClick={onRowClick}
                    >
                      <span className="flex items-center gap-1.5">
                        {pinned && <PinnedBadge />}
                        {link.note && <NoteBadge note={link.note} />}
                        <span className="truncate text-sm font-medium">
                          {link.title || displayUrl(link.url)}
                        </span>
                      </span>
                      {/* text-sm, matching the title's size — the host is the second
                          thing read, not a caption. mt-0.5 keeps the two lines from
                          touching. size-3.5 leaves the favicon a touch under the
                          14px cap height so it reads as a mark, not a third word;
                          the line box is 20 either way, which is what the row
                          budgets above count. */}
                      <span className="mt-0.5 flex items-center gap-1.5">
                        <Favicon host={hostFromText(link.url)} className="size-3.5 shrink-0" />
                        <span className="truncate text-sm text-muted-foreground">
                          {hostFromText(link.url)}
                        </span>
                      </span>
                    </a>
                    <LinkTagChips link={link} tagsById={tagsById} className="mt-3" />
                  </span>
                </div>
                {/* Sorted-field date column — only when the PANE is wide enough (@lg
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
                    isFirst={row.index === 0}
                    isLast={row.index === pinnedCount - 1}
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
