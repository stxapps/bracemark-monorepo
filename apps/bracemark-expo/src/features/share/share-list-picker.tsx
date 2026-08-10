// "Choose list" — the share sheet's own screen for picking the destination, and
// the share-sized RN cousin of components/links/list-command.tsx (whose header,
// and web-ui's ListCommand above it, are canonical for the rules). Rows in,
// events out: the screen owns reuse-or-mint and hands down the pending new list,
// so this same component can serve the iOS snapshot and Android's live read.
//
// IT IS A SCREEN, NOT A PANE, and that is the change that mattered most here.
// It used to be a `max-h-40` peephole — six rows of tree in 160px, nested inside
// the sheet's own ScrollView (hence `nestedScrollEnabled`), with a blind "New
// list…" input pinned under it. On a 520pt sheet that arrangement gave the
// 10% path most of the pixels and still had nowhere to put a tree. Now the sheet
// swaps to this screen and the list gets the height it needed, while the
// compose screen gets back to one glance and one tap.
//
// WHAT IT BORROWS FROM ListCommand, deliberately and line for line: one input
// that FILTERS as you type and doubles as the new list's name field; indented
// tree rows while the query is empty, flat rows labelled with their ancestor
// path once it isn't (a depth-3 match floating with no visible parent is
// unreadable); an explicit `Create "…"` row, suppressed on an exact
// case-insensitive match, since a Create row sitting above an identical row
// reads as a mistake. Someone who has picked a list in the app should not have
// to learn a second picker in the sheet.
//
// The one thing it does NOT borrow is the live read — the taxonomy arrives as
// props (a snapshot on iOS, sqlite on Android), and ancestor paths are
// reconstructed from the flat depth-ordered rows rather than shipped in the
// snapshot, so this needed no change to the cross-process schema.

import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView } from 'react-native';
import Check from 'lucide-react-native/icons/check';
import Plus from 'lucide-react-native/icons/plus';

import type { ShareNewEntity, ShareTaxonomyList } from '@stxapps/expo-react/data/share-store';

import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { ShareHeader, ShareSheet } from './share-kit';

type PathRow = { list: ShareTaxonomyList; ancestors: string[] };

// The ancestor names of every row, from the flat depth-ordered list alone: rows
// arrive in tree order, so the chain for a row at depth d is simply the last
// name seen at each depth below d. The stand-in for shared's `flattenToPathRows`
// (which needs the real tree) — and the reason `ShareTaxonomy` did not have to
// grow an `ancestors` field for the filtered view to be legible.
function withAncestors(lists: ShareTaxonomyList[]): PathRow[] {
  const stack: string[] = [];
  return lists.map((list) => {
    stack.length = list.depth;
    const ancestors = [...stack];
    stack[list.depth] = list.name;
    return { list, ancestors };
  });
}

export function ShareListPicker({
  lists,
  newList,
  selectedId,
  onSelect,
  onCreateName,
  onDone,
}: {
  lists: ShareTaxonomyList[];
  // The one pending sheet-minted list (created = selected; the screen discards
  // it when another row is picked), rendered as the top row.
  newList: ShareNewEntity | null;
  selectedId: string;
  onSelect: (listId: string) => void;
  // The typed name to reuse-or-mint — the screen decides which.
  onCreateName: (name: string) => void;
  // Back to the compose screen.
  onDone: () => void;
}) {
  const [query, setQuery] = useState('');
  const rows = useMemo(() => withAncestors(lists), [lists]);

  const trimmed = query.trim();
  const q = trimmed.toLowerCase();
  const filtering = q.length > 0;
  const visible = filtering ? rows.filter(({ list }) => list.name.toLowerCase().includes(q)) : rows;

  // The pending new list is matched too — it is a real destination on this
  // screen, so typing its name again must not offer to create a second one.
  const canCreate =
    trimmed !== '' &&
    !rows.some(({ list }) => list.name.toLowerCase() === q) &&
    newList?.name.toLowerCase() !== q;

  // Picking is the whole job of this screen, so it closes on the pick — one tap
  // out, no Done to hunt for. (Done is still there for the trip that changes
  // nothing; see the button below.)
  const select = useCallback(
    (id: string) => {
      onSelect(id);
      onDone();
    },
    [onSelect, onDone],
  );

  const create = useCallback(() => {
    if (trimmed === '') return;
    onCreateName(trimmed);
    onDone();
  }, [trimmed, onCreateName, onDone]);

  return (
    <ShareSheet>
      <ShareHeader back={{ title: 'Choose list', onPress: onDone }} />

      <Input
        testID="share-list-input"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={create}
        submitBehavior="submit"
        placeholder="Search or create lists…"
        aria-label="Search or create lists"
        autoCapitalize="none"
        autoCorrect={false}
        className="h-9"
      />

      {/* Bounded rather than `flex-1`: the panel has a definite height on iOS
          (the host's fixed 520pt) but not on Android (it grows to content, up to
          85%), and a max-height behaves correctly in both. No
          `nestedScrollEnabled` any more — this no longer scrolls inside another
          scroller. */}
      <ScrollView className="max-h-72" keyboardShouldPersistTaps="handled">
        {visible.length === 0 && !canCreate && (
          <Text className="px-2 py-2.5 text-sm text-muted-foreground">No lists found.</Text>
        )}

        {newList && !filtering && (
          <ListRow
            testID="share-new-list"
            name={newList.name}
            selected={newList.id === selectedId}
            onPress={() => select(newList.id)}
          />
        )}

        {visible.map(({ list, ancestors }) => (
          <ListRow
            key={list.id}
            testID={`share-list-${list.id}`}
            name={list.name}
            path={filtering && ancestors.length > 0 ? `${ancestors.join(' / ')} / ` : undefined}
            indent={filtering ? 0 : list.depth}
            selected={list.id === selectedId}
            onPress={() => select(list.id)}
          />
        ))}

        {canCreate && (
          <Pressable
            testID="share-list-create"
            onPress={create}
            accessibilityRole="button"
            className="flex-row items-center gap-2 rounded-md px-2 py-2.5 active:bg-muted"
          >
            <Icon as={Plus} className="size-4 shrink-0 text-muted-foreground" />
            <Text numberOfLines={1} className="min-w-0 flex-1">
              Create “{trimmed}”
            </Text>
          </Pressable>
        )}
      </ScrollView>

      {/* Outline, not primary: Save on the compose screen is the only primary
          action in the whole sheet, and this is the way back from a trip that
          changed nothing. It sits at the bottom because that is where the thumb
          is on a bottom-anchored sheet — the back control in the header is the
          farthest point on the screen from it. */}
      <Button variant="outline" size="lg" onPress={onDone}>
        <Text>Done</Text>
      </Button>
    </ShareSheet>
  );
}

function ListRow({
  testID,
  name,
  path,
  indent = 0,
  selected,
  onPress,
}: {
  testID: string;
  name: string;
  // The ancestor path, shown only while filtering (see the header).
  path?: string;
  indent?: number;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="menuitem"
      accessibilityState={{ selected }}
      className={cn(
        'flex-row items-center justify-between gap-2 rounded-md px-2 py-2.5 active:bg-muted',
      )}
      style={indent > 0 ? { paddingLeft: indent * 12 + 8 } : undefined}
    >
      <Text numberOfLines={1} className="min-w-0 flex-1">
        {path !== undefined && <Text className="text-muted-foreground">{path}</Text>}
        {name}
      </Text>
      {selected && <Icon as={Check} className="size-4 shrink-0 text-muted-foreground" />}
    </Pressable>
  );
}
