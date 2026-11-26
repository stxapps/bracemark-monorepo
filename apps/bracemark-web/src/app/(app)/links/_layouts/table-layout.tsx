'use client';

// The table layout (Plus and up — the `tableLayout` entitlement): one row per link,
// the title first and flexing, then the columns the user chose
// (docs/link-layouts.md, _the table_). Web only, and only on a wide pane — main.tsx
// renders ListLayout instead below TABLE_MIN_PANE_WIDTH, without the entitlement,
// or for a layout this build doesn't know.
//
// THE ONE BUDGETED LAYOUT. Every other layout MEASURES its rows (list-layout.tsx
// carries the argument, docs/client-queries.md the rule), because a title may wrap
// and a tag strip may take lines. Here every cell is ONE line, truncated — the
// title with an ellipsis, the tags behind "+N" (LinkTagChips at one line) — so a
// row's height is a constant and nothing a row holds can change it. So the
// virtualizer is told the height rather than measuring it, which makes the
// scrollbar exact and a jump to any row exact. The height is in REM, read off the
// root font size once (useRootScale), so it follows a raised browser font size the
// way the cells' own rem type does — a px constant there would clip every cell.
// 2.75rem is also the 44px touch target (docs/accessibility.md).
//
// NO SIDEWAYS SCROLL. When the chosen columns don't fit beside the title's minimum,
// the lowest-priority ones drop (fitTableColumns, @stxapps/shared) and the header
// grows a "+N hidden" button that opens the column chooser. A table that scrolls
// sideways hides the title's own column under a horizontal bar the user has to
// find, and on a trackpad a vertical flick that drifts moves the page sideways.
//
// SEMANTICS on the virtualized divs: `role="table"` on the scroller, `row`,
// `columnheader` and `cell` below, `aria-rowcount` and per-row `aria-rowindex`
// (the header is row 1), so a screen reader announces "row 12 of 200" though only
// a window of rows is mounted. A sortable header is a button inside its
// columnheader, with `aria-sort` on the header itself.
//
// The rest is the list layout's, through the same shared hooks: scroll-top on a
// new view, the return row from the reader, displayed-paths reporting for the
// extraction drain, the held snapshot behind the refresh pill, bulk-edit selection.

import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp } from 'lucide-react';

import { TABLE_COLUMN_COPY } from '@stxapps/react';
import {
  displayUrl,
  fitTableColumns,
  hostFromText,
  openableUrl,
  TABLE_COLUMNS,
  type TableColumnId,
} from '@stxapps/shared';
import { type LinkView, useSettingMutations, useSettings } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@stxapps/web-ui/components/ui/popover';
import { useElementWidth } from '@stxapps/web-ui/hooks/use-element-size';

import { useLinksViewState } from '../_contexts/view-state-provider';
import { RelativeTime } from './relative-time';
import {
  EmptyState,
  Favicon,
  KeptCopyBadge,
  type LinkLayoutProps,
  LinkRowMenu,
  LinkRowSelect,
  LinkTagChips,
  NoteBadge,
  PinnedBadge,
  RefreshPill,
  ShowMore,
  useListNameMap,
  useReportDisplayedLinkPaths,
  useRestoreReturnRow,
  useScrollTopOnQuery,
  useTagMap,
} from './shared';

import { TableColumnsChooser } from '@/components/table-columns-chooser';

const ROW_REM = 2.75;
const SCROLL_TOP_THRESHOLD = 8;
// What a row spends outside its columns: pl-4 + pr-2, the ⋯ menu's 32 + gap-3,
// and gap-3 before every chosen column.
const ROW_CHROME = 16 + 8 + 44;
const COLUMN_GAP = 12;
const SELECT_CHROME = 44;

// The root font size in force, as a scale of the 16px the column widths are
// written at (see the header). The row height is 2.75rem of it; the columns'
// widths and the title's minimum scale with it too — px widths held "blog.exampl…"
// under a 24px default font, and kept columns the text no longer fit (break-ui).
function useRootScale(): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
    if (Number.isFinite(root) && root > 0) setScale(root / 16);
  }, []);
  return scale;
}

function Cell({
  id,
  link,
  listNames,
  tagsById,
}: {
  id: TableColumnId;
  link: LinkView;
  listNames: Map<string, string>;
  tagsById: Map<string, string>;
}) {
  switch (id) {
    case 'host': {
      const host = hostFromText(link.url);
      return (
        <>
          <Favicon host={host} className="size-3.5 shrink-0" />
          <span dir="ltr" className="truncate text-sm text-muted-foreground">
            {host}
          </span>
        </>
      );
    }
    case 'url':
      return (
        <span dir="ltr" className="truncate text-sm text-muted-foreground">
          {displayUrl(link.url)}
        </span>
      );
    case 'listName':
      return (
        <span dir="auto" className="truncate text-sm text-muted-foreground">
          {listNames.get(link.listId) ?? ''}
        </span>
      );
    case 'tags':
      return <LinkTagChips link={link} tagsById={tagsById} className="w-full min-w-0" />;
    case 'createdAt':
      return <RelativeTime epochMs={link.createdAt} verb="Added" />;
    case 'updatedAt':
      return <RelativeTime epochMs={link.updatedAt} verb="Updated" />;
    case 'note':
      return link.note ? <NoteBadge note={link.note} /> : null;
    case 'keptCopy':
      return <KeptCopyBadge link={link} />;
  }
}

export function TableLayout({
  links,
  sortOn,
  pinnedCount,
  hasMore,
  showMore,
  isLoading,
  hasPending,
  applyPending,
}: LinkLayoutProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const paneWidth = useElementWidth(scrollEl);
  const scale = useRootScale();
  const rowHeight = Math.round(ROW_REM * 16 * scale);
  const { setScrolled, bulkEditing, selectedLinks, toggleSelected, selectRange } =
    useLinksViewState();
  const tagsById = useTagMap();
  const listNames = useListNameMap();
  const { layoutOptions, sortOrder } = useSettings();
  const { setSort, setLayoutOptions } = useSettingMutations();
  const { columns } = layoutOptions.table;

  // Before the pane is measured (0) every chosen column is shown; the first
  // measurement drops what doesn't fit.
  const available =
    paneWidth > 0
      ? paneWidth - ROW_CHROME - (bulkEditing ? SELECT_CHROME : 0) - COLUMN_GAP * columns.length
      : Infinity;
  // The fit is written in 16px-root widths, so the room is measured in them too.
  const { shown, hidden } = fitTableColumns(columns, available / scale);

  useEffect(() => {
    setScrolled(false);
    return () => setScrolled(false);
  }, [setScrolled]);

  useScrollTopOnQuery(() => scrollRef.current);

  const applyAndScrollTop = () => {
    applyPending();
    scrollRef.current?.scrollTo({ top: 0 });
  };

  const virtualizer = useVirtualizer({
    count: links.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => links[index]?.path ?? index,
    // The fixed height (see the header) — never measured.
    estimateSize: () => rowHeight,
    // The header row sits above the rows inside the same scroller.
    scrollMargin: rowHeight,
    overscan: 10,
  });

  // A root font size read after the first render changes every row's height.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  const rows = virtualizer.getVirtualItems();
  useReportDisplayedLinkPaths(
    links,
    rows.length ? rows[0].index : 0,
    rows.length ? rows[rows.length - 1].index : -1,
  );

  // Infinite scroll, gated per page — list-layout.tsx has the reasoning.
  const autoLoadedLengthRef = useRef(-1);
  useEffect(() => {
    if (!hasMore) return;
    const last = rows[rows.length - 1];
    if (last && last.index >= links.length - 1 && autoLoadedLengthRef.current !== links.length) {
      autoLoadedLengthRef.current = links.length;
      showMore();
    }
  }, [rows, hasMore, links.length, showMore]);

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

  // A date header sorts: the same column again flips the order, another date
  // column switches the field. It writes the sort on whichever source is active —
  // the value Settings → Appearance and View options write too.
  const sortBy = (field: NonNullable<(typeof TABLE_COLUMNS)[TableColumnId]['sortOn']>) =>
    void (field === sortOn
      ? setSort({ sortOrder: sortOrder === 'desc' ? 'asc' : 'desc' })
      : setSort({ sortOn: field }));

  return (
    <div className="relative h-full">
      <RefreshPill show={hasPending} onClick={applyAndScrollTop} />
      <div
        ref={(el) => {
          scrollRef.current = el;
          setScrollEl(el);
        }}
        role="table"
        aria-label="Links"
        // +1 for the header row. While more pages remain the true total is unknown.
        aria-rowcount={hasMore ? -1 : links.length + 1}
        // `scrollbar-gutter-stable` for list-layout.tsx's reason: this box's width
        // is read by code (the column fit), and a scrollbar coming and going would
        // move it by 15px.
        className="h-full scrollbar-gutter-stable overflow-y-auto"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > SCROLL_TOP_THRESHOLD)}
      >
        <div role="rowgroup" className="sticky top-0 z-20 bg-background">
          <div
            role="row"
            aria-rowindex={1}
            style={{ height: rowHeight }}
            className="flex items-center gap-3 border-b border-border pr-2 pl-4 text-xs font-medium text-muted-foreground"
          >
            {bulkEditing && <span aria-hidden className="w-8 shrink-0" />}
            <div role="columnheader" className="min-w-0 flex-1">
              Title
            </div>
            {shown.map((id) => {
              const def = TABLE_COLUMNS[id];
              const field = def.sortOn;
              const active = field !== undefined && field === sortOn;
              return (
                <div
                  key={id}
                  role="columnheader"
                  aria-sort={
                    active ? (sortOrder === 'desc' ? 'descending' : 'ascending') : undefined
                  }
                  style={{ width: def.width * scale }}
                  className="flex shrink-0 items-center"
                >
                  {field ? (
                    <button
                      type="button"
                      className="-mx-1 flex items-center gap-1 rounded px-1 py-1 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                      onClick={() => sortBy(field)}
                    >
                      {TABLE_COLUMN_COPY[id]}
                      {active &&
                        (sortOrder === 'desc' ? (
                          <ArrowDown className="size-3.5" aria-hidden />
                        ) : (
                          <ArrowUp className="size-3.5" aria-hidden />
                        ))}
                    </button>
                  ) : (
                    TABLE_COLUMN_COPY[id]
                  )}
                </div>
              );
            })}
            <div role="columnheader" className="flex w-8 shrink-0 justify-center">
              {hidden.length > 0 ? (
                // The columns that didn't fit, and the way to choose others.
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-1.5 text-xs"
                      aria-label={`${hidden.length} ${hidden.length === 1 ? 'column' : 'columns'} hidden — choose columns`}
                    >
                      +{hidden.length}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="w-80 gap-2"
                    aria-labelledby="table-columns-title"
                  >
                    <PopoverTitle id="table-columns-title">Columns</PopoverTitle>
                    <p className="text-sm text-muted-foreground">
                      The ones that don’t fit this window are hidden, starting with the least
                      important.
                    </p>
                    <TableColumnsChooser
                      idPrefix="table-header"
                      columns={columns}
                      onChange={(next) => void setLayoutOptions({ table: { columns: next } })}
                    />
                  </PopoverContent>
                </Popover>
              ) : (
                <span className="sr-only">Actions</span>
              )}
            </div>
          </div>
        </div>
        <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((row) => {
            const link = links[row.index];
            const pinned = row.index < pinnedCount;
            const title = link.title || displayUrl(link.url);
            const href = openableUrl(link.url);
            const selected = bulkEditing && selectedLinks.has(link.path);
            // Bulk edit: the row owns the click — list-layout.tsx has the rule.
            const onRowClick = bulkEditing
              ? (e: React.MouseEvent) => {
                  if (e.shiftKey) selectRange(link, links);
                  else toggleSelected(link);
                }
              : undefined;
            return (
              <div
                key={link.path}
                role="row"
                aria-rowindex={row.index + 2}
                aria-selected={bulkEditing ? selected : undefined}
                className={`absolute inset-x-0 top-0 flex items-center gap-3 border-b border-border pr-2 pl-4 ${
                  selected ? 'bg-muted' : 'hover:bg-muted/50 has-[a:active]:bg-muted'
                } ${bulkEditing ? 'cursor-pointer select-none active:bg-muted' : ''}`}
                style={{
                  height: rowHeight,
                  transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
                }}
                onClick={onRowClick}
              >
                {bulkEditing && (
                  <div role="cell">
                    <LinkRowSelect link={link} links={links} />
                  </div>
                )}
                <div role="cell" className="flex min-w-0 flex-1 items-center gap-2">
                  {pinned && <PinnedBadge />}
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    dir="auto"
                    title={title}
                    className="truncate text-sm font-medium"
                    onClick={bulkEditing ? (e) => e.preventDefault() : undefined}
                  >
                    {title}
                  </a>
                </div>
                {shown.map((id) => (
                  <div
                    key={id}
                    role="cell"
                    style={{ width: TABLE_COLUMNS[id].width * scale }}
                    className="flex min-w-0 shrink-0 items-center gap-1.5 overflow-hidden"
                  >
                    <Cell id={id} link={link} listNames={listNames} tagsById={tagsById} />
                  </div>
                ))}
                <div role="cell" className="flex w-8 shrink-0 justify-center">
                  {!bulkEditing && (
                    <LinkRowMenu
                      link={link}
                      pinned={pinned}
                      pinnedAbove={row.index > 0 && pinned ? links[row.index - 1] : undefined}
                      pinnedBelow={row.index < pinnedCount - 1 ? links[row.index + 1] : undefined}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <ShowMore hasMore={hasMore} showMore={showMore} />
      </div>
    </div>
  );
}
