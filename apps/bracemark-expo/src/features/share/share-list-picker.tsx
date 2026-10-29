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
import { TREE_PATH_CUT, TREE_ROW_MAX_LEVELS } from '@stxapps/shared';

import { GuideLines } from '../../components/links/guide-lines';
import { Button } from '../../components/ui/button';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { ScrollClaim } from '../../components/ui/scroll-claim';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { ShareHeader, ShareSheet } from './share-kit';

type PathRow = { list: ShareTaxonomyList; ancestors: string[] };

// The ancestor names of every row, from the flat depth-ordered list alone: rows
// arrive in tree order, so the chain for a row at depth d is simply the last
// name seen at each depth below d. The stand-in for shared's `flattenToPathRows`
// (which needs the real tree) — and the reason `ShareTaxonomy` did not have to
// grow an `ancestors` field for the filtered view to be legible.
//
// Under the same bound as that walk, TREE_ROW_MAX_LEVELS: a row deeper than it
// gets that many names and then TREE_PATH_CUT, and the stack never tracks a
// level past it. Copying each row's whole chain made one deep `parentId` chain
// cost the square of its length in names — in the process with the least memory
// to spend on it (docs/share-sheet.md).
function withAncestors(lists: ShareTaxonomyList[]): PathRow[] {
  const stack: string[] = [];
  return lists.map((list) => {
    stack.length = Math.min(list.depth, TREE_ROW_MAX_LEVELS);
    const ancestors = list.depth > TREE_ROW_MAX_LEVELS ? [...stack, TREE_PATH_CUT] : [...stack];
    if (list.depth < TREE_ROW_MAX_LEVELS) stack[list.depth] = list.name;
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
  // it when another row is picked), rendered as the top row and filtered like
  // any other.
  newList: ShareNewEntity | null;
  selectedId: string;
  onSelect: (listId: string) => void;
  // The typed name to reuse-or-mint — the screen decides which.
  onCreateName: (name: string) => void;
  // Back to the compose screen.
  onDone: () => void;
}) {
  const [query, setQuery] = useState('');
  // The pending new list joins the rows as the head of the root group — where
  // its rank will put it (share-screen's submitListName prepends), and where
  // every create lands (docs/editors.md, _every create lands in the same
  // place_). As a ROW rather than a block drawn beside them, so it is a real
  // destination on this screen in every respect: the filter finds it, and
  // typing its name again neither reads "No lists found." nor offers to create
  // a second one.
  const rows = useMemo(
    () => withAncestors(newList ? [{ ...newList, depth: 0 }, ...lists] : lists),
    [lists, newList],
  );

  const trimmed = query.trim();
  const q = trimmed.toLowerCase();
  const filtering = q.length > 0;
  const visible = filtering ? rows.filter(({ list }) => list.name.toLowerCase().includes(q)) : rows;

  const canCreate = trimmed !== '' && !rows.some(({ list }) => list.name.toLowerCase() === q);

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
    <ShareSheet screen="list-picker" holdSwipe>
      <ShareHeader back={{ title: 'Choose list', onPress: onDone }} />

      <Input
        testID="share-list-input"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={create}
        submitBehavior="submit"
        placeholder="Search or create lists…"
        aria-label="Search or create lists"
        className="h-9"
      />

      {/* Bounded rather than `flex-1`, since neither host gives the panel a
          height to fill — both grow it to content (Android caps at 85%) — and a
          max-height behaves correctly in both. No `nestedScrollEnabled` any
          more: this no longer scrolls inside another scroller.

          `min-h-0 shrink` is the LAST link of the sheet's squeeze chain
          (share-kit.tsx's header): the scroller is the only child of either
          picker that may lose height, so when the keyboard takes the room this
          is what gives it up, and the header, the field and Done stay put. Miss
          it and the panel overflows the frame instead — nothing clips, it just
          paints outside its own background.

          `keyboardDismissMode="interactive"`, not the app's usual `on-drag`,
          for list-command.tsx's reason and a bigger jump than the one there:
          the panel is parked on the keyboard, so `on-drag` dropped the keyboard
          at the start of a scroll and the whole sheet fell a keyboard's height
          out from under the finger while this list regrew. A scroll now keeps
          the keyboard (Android maps the value to `none`). The input above is
          `submitBehavior="submit"`, so return never blurs it either: the way
          out is the tap layer in ShareSheet, whose header carries the whole
          argument. `"handled"` beside it keeps a row tap a row tap: without it
          the default `"never"` would swallow the first press on the very row
          you filtered for.

          A PULL DOWN FROM THE TOP OF THIS LIST IS NOT OURS on iOS, in either
          mode: the share extension sits in a system sheet, and with the list at
          its top the pull goes to that sheet's swipe-to-dismiss. A short one
          tucks the keyboard away and brings it back, the field never having
          blurred — so don't count on "drag down into the keys" as a keyboard
          exit here. A long one used to close the sheet and the unsaved share
          with it; `holdSwipe` on ShareSheet above is what holds that off
          (share-kit.tsx, docs/share-sheet.md). */}
      <ScrollView
        className="max-h-72 min-h-0 shrink"
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {/* ScrollClaim: ShareSheet's frame around this claims touches, so a
            drag from the empty text would not scroll on iOS
            (components/ui/scroll-claim.tsx). */}
        <ScrollClaim>
          {visible.length === 0 && !canCreate && (
            <Text className="py-6 text-center text-sm text-muted-foreground">No lists found.</Text>
          )}

          {visible.map(({ list, ancestors }) => (
            <ListRow
              key={list.id}
              testID={list.id === newList?.id ? 'share-new-list' : `share-list-${list.id}`}
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
              className="min-h-11 flex-row items-center gap-2 rounded-xl px-3 py-2.5 active:bg-muted"
            >
              <Icon as={Plus} className="size-4 shrink-0 text-muted-foreground" />
              <Text numberOfLines={1} className="min-w-0 flex-1">
                Create “{trimmed}”
              </Text>
            </Pressable>
          )}
        </ScrollClaim>
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
        'min-h-11 flex-row items-center justify-between gap-2 rounded-xl px-3 py-2.5 active:bg-muted',
      )}
    >
      {/* The depth is DRAWN, not padded — one guide line per level, the same
          leaf component the in-app picker uses (guide-lines.tsx carries the
          derivation). `min-h-11` above is the 44pt target every picker row
          takes. Both are list-command.tsx's ListCommand, line for line
          (docs/share-sheet.md). */}
      {indent > 0 && <GuideLines depth={indent} />}
      {/* `middle` under a path, so the cut takes ancestors and not the name. */}
      <Text
        numberOfLines={1}
        ellipsizeMode={path !== undefined ? 'middle' : 'tail'}
        className="min-w-0 flex-1"
      >
        {path !== undefined && <Text className="text-muted-foreground">{path}</Text>}
        {name}
      </Text>
      {selected && <Icon as={Check} className="size-4 shrink-0 text-muted-foreground" />}
    </Pressable>
  );
}
