'use client';

// The searchable list command shared by every "pick a list" surface: ListSelect
// wraps it in a popover for the editors, the link row menu's "Move to" embeds it
// in a dropdown submenu, and the Lists settings reparent menu embeds it too —
// one implementation of the tree rendering, search behavior, and path labels
// instead of per-surface drift. The reparent menu additionally opts into the
// `root` ("Top level") item: moving a *list* to no parent is a valid target that
// a *link*-move never has (a link always lands in some list).
//
// Past SEARCH_THRESHOLD items a filter input appears at the top. Two render
// modes, because filtering breaks indentation's meaning (a depth-3 match would
// float with no visible parent): an empty query shows the whole indented tree
// with per-level guide lines; a non-empty query shows flat matches labelled
// with their ancestor path ("Work / Cooking / Recipes"). Query state lives
// here, so a host that unmounts its content on close (popover, submenu) resets
// the search for free.
//
// The editors additionally opt into `onCreate` — a Create row that mints a list
// named by the typed query, the list analogue of TagsCommand's. Like `root`, it's
// opt-in precisely because the two "Move to" menus must NOT offer it: creating a
// list is incoherent as a *move destination*, and doubly so in the Lists settings
// menu, which picks a PARENT. See list-select.tsx for why the create is
// top-level-only and why the editors need it inline at all.

import { useMemo, useState } from 'react';
import { PlusIcon } from 'lucide-react';

import { flattenToPathRows, type TreePathRow } from '@stxapps/shared';
import { type ListItem, useLists } from '@stxapps/web-react';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@stxapps/web-ui/components/ui/command';
import { cn } from '@stxapps/web-ui/lib/utils';

// Below this many lists, scrolling beats a filter box — don't render one.
const SEARCH_THRESHOLD = 10;

// cmdk values for the optional `root` and Create items. Reserved sentinels that
// can't collide with a list id (user ids are UUIDs, system ids are slugs like
// 'my-list'), so `shouldFilter={false}` keyboard nav treats each as just another
// distinct row.
const ROOT_VALUE = '__root__';
const CREATE_VALUE = '__create__';

export type ListRow = TreePathRow<ListItem>;

// The live list tree flattened depth-first, each row carrying its ancestor names
// — the path shown on filtered rows and on ListSelect's trigger. The walk is
// shared's `flattenToPathRows`; this just binds it to the live `useLists` read.
// `excludeIds` drops rows entirely (Trash in the editors — a leaf, so no children
// get orphaned); hosts that need "visible but not selectable" use ListCommand's
// `disabledIds` instead.
export function useListRows(excludeIds?: readonly string[]): ListRow[] {
  const lists = useLists();
  return useMemo(() => flattenToPathRows(lists, excludeIds), [lists, excludeIds]);
}

export function ListCommand({
  value,
  onSelect,
  excludeIds,
  disabledIds,
  root,
  onCreate,
  className,
}: {
  // The current list id — its row gets the check mark.
  value?: string;
  onSelect: (listId: string) => void;
  // Rows to leave out entirely (see useListRows).
  excludeIds?: readonly string[];
  // Rows kept visible but not selectable — e.g. the link's current list in the
  // row menu's Move to, so the tree's shape (and the user's bearings) stays
  // intact while ruling out a no-op move.
  disabledIds?: readonly string[];
  // An optional "no parent" entry rendered above the tree, for surfaces where
  // selecting *nothing* is a real target with no list id — the Lists settings
  // reparent menu ("Top level"). `selected` gives it the check mark and disables
  // it (already at the root, so moving there is a no-op), mirroring how `value` /
  // `disabledIds` treat the current-parent list row. Omitted by link surfaces.
  root?: { label: string; selected: boolean; onSelect: () => void };
  // Mint a list named by the typed query and select it (the editors' ListSelect
  // passes this; the move-to menus don't — see the header). Awaited, so the row
  // can disable itself while the write lands.
  onCreate?: (name: string) => void | Promise<void>;
  className?: string;
}) {
  const rows = useListRows(excludeIds);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  // The input is normally count-gated (below the threshold, scrolling beats a
  // filter box) — but when this instance can create, the input is ALSO the Create
  // row's name field, so it earns its keep at any count. Without this a small
  // account would have nothing to type into, which is most accounts.
  const searchable = rows.length > SEARCH_THRESHOLD || onCreate !== undefined;
  const trimmed = query.trim();
  const q = trimmed.toLowerCase();
  const filtering = searchable && q.length > 0;
  const visibleRows = filtering
    ? rows.filter(({ item }) => item.name.toLowerCase().includes(q))
    : rows;

  // Offer Create unless the name is empty or already names a list exactly
  // (case-insensitive). Note this is STRICTER than it strictly has to be: unlike
  // a tag, a list isn't identified by its name, so a second "Recipes" under a
  // different parent is legitimate. But a Create row competing with an identical
  // row sitting right above it reads as a mistake far more often than as intent,
  // and the deliberate-duplicate case still has Settings → Lists. Suppress it.
  const canCreate =
    onCreate !== undefined &&
    trimmed !== '' &&
    !rows.some(({ item }) => item.name.toLowerCase() === q);

  const create = async () => {
    if (!onCreate || creating || trimmed === '') return;
    setCreating(true);
    try {
      await onCreate(trimmed);
      setQuery('');
    } finally {
      setCreating(false);
    }
  };

  return (
    /* Without an input, cmdk's arrow-key nav needs the root focusable. */
    <Command
      shouldFilter={false}
      tabIndex={searchable ? undefined : 0}
      className={cn('rounded-2xl outline-none', className)}
    >
      {searchable && (
        <CommandInput
          placeholder={onCreate ? 'Search or create lists…' : 'Search lists…'}
          value={query}
          onValueChange={setQuery}
        />
      )}
      <CommandList>
        {/* Suppressed when there's a Create row: that row IS the next step, so
            "No lists found." would just be noise above it. */}
        {!canCreate && <CommandEmpty>No lists found.</CommandEmpty>}
        {root && !filtering && (
          // Hidden while filtering: it has no name to match, and the flat
          // filtered view is name-matches only (like the indent guides).
          <>
            <CommandItem
              value={ROOT_VALUE}
              disabled={root.selected}
              data-checked={root.selected}
              onSelect={() => root.onSelect()}
            >
              <span className="truncate">{root.label}</span>
            </CommandItem>
            <CommandSeparator />
          </>
        )}
        {visibleRows.map(({ item, depth, ancestors }) => (
          <CommandItem
            key={item.id}
            value={item.id}
            disabled={disabledIds?.includes(item.id)}
            data-checked={item.id === value}
            // cmdk may normalize `value`, so pass the id via closure.
            onSelect={() => onSelect(item.id)}
          >
            {!filtering && depth > 0 && (
              // Guide lines, one per level; -my-2 runs them through the
              // row padding so they connect across adjacent rows.
              <span aria-hidden className="-my-2 flex self-stretch">
                {Array.from({ length: depth }, (_, i) => (
                  <span key={i} className="w-4 border-l border-border" />
                ))}
              </span>
            )}
            <span className="truncate">
              {filtering && ancestors.length > 0 && (
                <span className="text-muted-foreground">
                  {ancestors.join(' / ')}
                  {' / '}
                </span>
              )}
              {item.name}
            </span>
          </CommandItem>
        ))}
        {canCreate && (
          <CommandItem value={CREATE_VALUE} disabled={creating} onSelect={() => void create()}>
            <PlusIcon />
            <span className="truncate">Create “{trimmed}”</span>
          </CommandItem>
        )}
      </CommandList>
    </Command>
  );
}
