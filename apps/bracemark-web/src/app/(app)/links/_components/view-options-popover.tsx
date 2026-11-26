'use client';

// The links page's View options: the layout, its display options and the sort,
// edited in place with the page live behind the popover (docs/link-layouts.md).
// The same controls Settings → Appearance has (components/layout-options-controls
// — one component, so the two can't drift), bound to whichever source of the pack
// is ACTIVE on this device: the setters are the unprefixed ones
// (useSettingMutations' setLinksLayout / setLayoutOptions / setSort), which read
// `linksLayoutSource` at call time. So this never asks "Sync or Device?" — it
// edits what you are looking at, and says where that is saved, with the way to
// change it (the Appearance section, which owns the switch).
//
// A popover, not a dialog: it doesn't take the page away, so each change is seen
// landing on the rows it changes. Radix returns focus to the trigger on close
// (docs/accessibility.md, _focus return_). Its options are compact Select/Switch
// rows, each at least 44px tall for the switches' hit areas
// (layout-options-controls.tsx).

import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import Link from 'next/link';

import { LAYOUT_OPTION_COPY, SORT_ON_OPTION_COPY, SORT_ORDER_OPTION_COPY } from '@stxapps/react';
import {
  LINK_SORT_ONS,
  LINK_SORT_ORDERS,
  LINKS_LAYOUTS,
  type LinksLayout,
  type LinkSortOn,
  type LinkSortOrder,
} from '@stxapps/shared';
import { useEntitlements, useSettingMutations, useSettings } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@stxapps/web-ui/components/ui/popover';

import { useLinksViewState } from '../_contexts/view-state-provider';

import { ChoiceRow, LayoutOptionsControls } from '@/components/layout-options-controls';
import { TableColumnsChooser } from '@/components/table-columns-chooser';
import { usePaywall } from '@/contexts/paywall-provider';

// The icon that opens it, at `md` and up. Below `md` the topbar is a title and four
// actions already, and a fifth squeezed the title to "My …" at 320px (break-ui), so
// there the ⋯ menu carries a View options item instead (more-options-menu.tsx) —
// the same move bracemark-expo makes on a phone header.
export function ViewOptionsTrigger() {
  return (
    <PopoverTrigger asChild>
      <Button variant="ghost" size="icon" aria-label="View options" className="max-md:hidden">
        <SlidersHorizontal className="size-4" />
      </Button>
    </PopoverTrigger>
  );
}

// Controlled, and ANCHORED to `children` (the topbar's action group, which holds
// ViewOptionsTrigger) rather than to its trigger alone: below `md` the trigger is
// hidden and the popover opens from the ⋯ menu, and an anchor that is
// `display: none` has no box to place it by. Anchored to the group, it opens under
// the bar's trailing edge either way.
export function ViewOptionsPopover({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const { linksLayout, linksLayoutSource, layoutOptions, sortOn, sortOrder } = useSettings();
  const { setLinksLayout, setLayoutOptions, setSort } = useSettingMutations();
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const { tableTooNarrow } = useLinksViewState();
  const [error, setError] = useState<string | null>(null);
  // A layout this build doesn't know (a newer client's) shows no options — the
  // page is rendering its fallback, and the Layout select reads as unset.
  const optionLayout = linksLayout === 'card' || linksLayout === 'list' ? linksLayout : undefined;

  const run = (op: Promise<unknown>) => {
    setError(null);
    void op.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        align="end"
        // Never wider than the room beside the collision padding: at a 320px window
        // `w-80` alone ran 7px off the right edge (break-ui).
        className="w-80 max-w-(--radix-popover-content-available-width) gap-3"
        aria-labelledby="view-options-title"
      >
        <PopoverTitle id="view-options-title">View options</PopoverTitle>
        <div className="flex flex-col">
          <ChoiceRow<LinksLayout>
            id="view-layout"
            label="Layout"
            value={linksLayout as LinksLayout}
            values={LINKS_LAYOUTS}
            copy={(v) => LAYOUT_OPTION_COPY[v].label}
            // The table is Plus: a free account gets the upgrade, not the write.
            onChange={(layout) =>
              layout === 'table' && !entitlements.tableLayout
                ? paywall.show('tableLayout')
                : run(setLinksLayout(layout))
            }
          />
          {/* The page is showing the list in the table's place (resolve-layout.ts):
              say why, or picking Table here looks like it did nothing. A live
              region, so a screen reader hears it right after the pick. */}
          <p role="status" className="text-sm text-muted-foreground empty:hidden">
            {tableTooNarrow
              ? 'This window is too narrow for the table, so the list shows instead. Make the window wider to see the table.'
              : ''}
          </p>
          {linksLayout === 'table' && (
            <TableColumnsChooser
              idPrefix="view"
              columns={layoutOptions.table.columns}
              onChange={(columns) => run(setLayoutOptions({ table: { columns } }))}
            />
          )}
          {optionLayout && (
            <LayoutOptionsControls
              idPrefix="view"
              layout={optionLayout}
              options={layoutOptions}
              onChange={(patch) => run(setLayoutOptions(patch))}
            />
          )}
          <ChoiceRow<LinkSortOn>
            id="view-sort-on"
            label="Sort by"
            value={sortOn as LinkSortOn}
            values={LINK_SORT_ONS}
            copy={(v) => SORT_ON_OPTION_COPY[v].label}
            onChange={(on) => run(setSort({ sortOn: on }))}
          />
          <ChoiceRow<LinkSortOrder>
            id="view-sort-order"
            label="Order"
            value={sortOrder as LinkSortOrder}
            values={LINK_SORT_ORDERS}
            copy={(v) => SORT_ORDER_OPTION_COPY[v].label}
            onChange={(order) => run(setSort({ sortOrder: order }))}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {linksLayoutSource === 'local'
            ? 'Saved on this device only.'
            : 'Saved on all your devices.'}{' '}
          <Link href="/settings/appearance" className="underline underline-offset-4">
            Change in Settings
          </Link>
        </p>
      </PopoverContent>
    </Popover>
  );
}
