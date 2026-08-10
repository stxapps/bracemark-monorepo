// The list picker body shared by every "pick a list" dialog — the expo port of
// web-ui's ListCommand (that header is canonical for the shared rules): the
// editors' ListSelect embeds it in its dialog, the links MoveToDialog embeds it
// for the row menu + bulk bar, and the Lists settings reparent dialog embeds it
// too — one implementation of the tree rendering, search behavior, and path
// labels instead of per-surface drift. No anchored popover on a phone, so hosts
// are Dialogs, and this renders plain content (Input + ScrollView, no shell)
// for a host's DialogContent to lay out; cmdk's keyboard nav has no analogue
// here — rows are Pressables.
//
// Past SEARCH_THRESHOLD rows a filter input appears at the top (forced on
// whenever `onCreate` is set, since the input doubles as the Create row's name
// field — most accounts are small; without it there'd be nothing to type into).
// Two render modes, because filtering breaks indentation's meaning (a depth-3
// match would float with no visible parent): an empty query shows the indented
// tree; a non-empty query shows flat matches labelled with their ancestor path
// ("Work / Cooking / Recipes"). Query state lives here, so a host whose Dialog
// unmounts its content on close resets the search for free.
//
// `excludeIds` drops rows entirely; `disabledIds` keeps them visible but not
// selectable (the current list/parent, so the tree's shape — and the user's
// bearings — stays intact while ruling out a no-op move). `root` is the
// opt-in "no parent" entry for the settings reparent dialog ("Top level");
// `onCreate` is the editors' opt-in Create row — the two "Move to" hosts must
// pass NEITHER (creating a list is incoherent as a move destination). All
// per web ListCommand.
//
// Holds a live list read (useLists) — per-item hosts must let their Dialog
// unmount this while closed (it does: the dialog portal renders null when
// closed), or one live query per virtualized item (the useTagMap rationale).

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Check, Plus } from 'lucide-react-native';

import { type ListItem, useLists } from '@stxapps/expo-react';
import { flattenToPathRows, type TreePathRow } from '@stxapps/shared';

import { cn } from '../../lib/utils';
import { Icon } from '../ui/icon';
import { Input } from '../ui/input';
import { Text } from '../ui/text';

// Below this many lists, scrolling beats a filter box — don't render one
// (unless the input is the create name field, above).
const SEARCH_THRESHOLD = 10;

export type ListRow = TreePathRow<ListItem>;

// The live list tree flattened depth-first, each row carrying its ancestor names
// — same as web list-command's useListRows: both bind shared's `flattenToPathRows`
// to the live `useLists` read. The path shown on filtered rows and on ListSelect's
// trigger. `excludeIds` drops rows entirely (Trash in the editors — a leaf, so no
// children get orphaned; the reparent dialog's forbidden subtree — every
// descendant is in the set, so none get orphaned either); hosts that need
// "visible but not selectable" use ListCommand's `disabledIds` instead.
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
}: {
  // The current list id — its row gets the check mark.
  value?: string;
  onSelect: (listId: string) => void;
  // Rows to leave out entirely (see useListRows).
  excludeIds?: readonly string[];
  // Rows kept visible but not selectable — e.g. the link's current list in the
  // Move to dialog (see the header).
  disabledIds?: readonly string[];
  // An optional "no parent" entry rendered above the tree, for surfaces where
  // selecting *nothing* is a real target with no list id — the Lists settings
  // reparent dialog ("Top level"). `selected` gives it the check mark and
  // disables it (already at the root, so moving there is a no-op), mirroring
  // how `value` / `disabledIds` treat the current-parent list row. Omitted by
  // link surfaces.
  root?: { label: string; selected: boolean; onSelect: () => void };
  // Mint a list named by the typed query and select it (the editors' ListSelect
  // passes this; the move-to hosts don't — see the header). Awaited, so the row
  // can disable itself while the write lands.
  onCreate?: (name: string) => void | Promise<void>;
}) {
  const rows = useListRows(excludeIds);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const searchable = rows.length > SEARCH_THRESHOLD || onCreate !== undefined;
  const trimmed = query.trim();
  const q = trimmed.toLowerCase();
  const filtering = searchable && q.length > 0;
  const visibleRows = filtering
    ? rows.filter(({ item }) => item.name.toLowerCase().includes(q))
    : rows;

  // Offer Create unless the name is empty or already names a list exactly
  // (case-insensitive) — a Create row competing with an identical row right
  // above it reads as a mistake; Settings → Lists still covers the deliberate
  // duplicate (web ListCommand's rule, verbatim).
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
    <>
      {searchable && (
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder={onCreate ? 'Search or create lists…' : 'Search lists…'}
          aria-label={onCreate ? 'Search or create lists' : 'Search lists'}
          autoCapitalize="none"
          autoCorrect={false}
          className="h-9"
        />
      )}
      <ScrollView className="max-h-80" nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {/* Suppressed when there's a Create row: that row IS the next step. */}
        {visibleRows.length === 0 && !canCreate && (
          <Text className="px-2 py-2.5 text-sm text-muted-foreground">No lists found.</Text>
        )}
        {root && !filtering && (
          // Hidden while filtering: it has no name to match, and the flat
          // filtered view is name-matches only.
          <>
            <Pressable
              disabled={root.selected}
              onPress={() => root.onSelect()}
              accessibilityRole="menuitem"
              className={cn(
                'flex-row items-center justify-between gap-2 rounded-md px-2 py-2.5 active:bg-muted',
                root.selected && 'opacity-50',
              )}
            >
              <Text numberOfLines={1} className="min-w-0 flex-1">
                {root.label}
              </Text>
              {root.selected && (
                <Icon as={Check} className="size-4 shrink-0 text-muted-foreground" />
              )}
            </Pressable>
            <View className="my-1 h-px bg-border" />
          </>
        )}
        {visibleRows.map(({ item, depth, ancestors }) => {
          const disabled = disabledIds?.includes(item.id) === true;
          return (
            <Pressable
              key={item.id}
              disabled={disabled}
              onPress={() => onSelect(item.id)}
              accessibilityRole="menuitem"
              className={cn(
                'flex-row items-center justify-between gap-2 rounded-md px-2 py-2.5 active:bg-muted',
                disabled && 'opacity-50',
              )}
              style={!filtering && depth > 0 ? { paddingLeft: depth * 12 + 8 } : undefined}
            >
              <Text numberOfLines={1} className="min-w-0 flex-1">
                {filtering && ancestors.length > 0 && (
                  <Text className="text-muted-foreground">{`${ancestors.join(' / ')} / `}</Text>
                )}
                {item.name}
              </Text>
              {item.id === value && (
                <Icon as={Check} className="size-4 shrink-0 text-muted-foreground" />
              )}
            </Pressable>
          );
        })}
        {canCreate && (
          <Pressable
            disabled={creating}
            onPress={() => void create()}
            accessibilityRole="menuitem"
            className={cn(
              'flex-row items-center gap-2 rounded-md px-2 py-2.5 active:bg-muted',
              creating && 'opacity-50',
            )}
          >
            <Icon as={Plus} className="size-4 shrink-0 text-muted-foreground" />
            <Text numberOfLines={1} className="min-w-0 flex-1">
              Create “{trimmed}”
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </>
  );
}
