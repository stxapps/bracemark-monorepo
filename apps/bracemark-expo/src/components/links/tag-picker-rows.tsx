import { memo } from 'react';
import { Pressable, View } from 'react-native';
import Check from 'lucide-react-native/icons/check';
import Plus from 'lucide-react-native/icons/plus';

import { cn } from '../../lib/utils';
import { Icon } from '../ui/icon';
import { Text } from '../ui/text';

// The presentational rows shared by the in-app TagsCommand and the share
// sheet's snapshot-fed tag picker. Data ownership deliberately stays outside:
// the app reads live tags and creates immediately, while the share sheet reads a
// snapshot and defers new entities until Save. What should not drift with those
// constraints is the control itself — a full-width checkbox row, its trailing
// check, and the Create row beneath the same filtered results.
//
// A row is at least 44pt tall, so it is its own touch target. Unlike the old
// wrapped chip cloud it needs no hitSlop competing with a pressable neighbour,
// and long names get the full picker width before they truncate.
//
// `px-3` is WEB'S number, and deliberately so: web-ui's CommandItem is `px-3`,
// this is the same row of the same picker, and the two ports should put a tag
// name in the same place (docs/theme.md, _ported_ — the same rule the dropdown
// row follows). It sat at `px-2` until the hosts on both platforms pulled their
// picker onto the dialog's text column, at which point the last 4px of drift was
// all that was left between them. `py-2.5` beside it is NOT web's `py-2` and
// must not be flattened to it: every native size is one step taller than web's,
// and it is what fills the `min-h-11` above on a one-line row.

export type TagPickerRow = {
  id: string;
  name: string;
  selected: boolean;
};

// The two pieces a tag picker lays out — one row per tag, and the Create row
// beneath them — for a host that puts them in its own scroller: TagsCommand and
// the share sheet's tag picker both hand them to PickerList (picker-list.tsx), a
// FlatList, so only the rows on screen are mounted.

export const TagPickerItem = memo(function TagPickerItem({
  row,
  testID,
  onToggle,
}: {
  row: TagPickerRow;
  testID?: string;
  onToggle: (id: string) => void;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={() => onToggle(row.id)}
      role="checkbox"
      aria-checked={row.selected}
      aria-label={row.name}
      className="min-h-11 flex-row items-center justify-between gap-2 rounded-xl px-3 py-2.5 active:bg-muted"
    >
      <Text numberOfLines={1} className="min-w-0 flex-1">
        {row.name}
      </Text>
      <View className="size-4 shrink-0 items-center justify-center">
        {row.selected && <Icon as={Check} className="size-4 text-muted-foreground" />}
      </View>
    </Pressable>
  );
});

export function TagPickerCreateRow({
  name,
  creating = false,
  onCreate,
  testID,
}: {
  name: string;
  creating?: boolean;
  onCreate: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      disabled={creating}
      onPress={onCreate}
      role="button"
      aria-label={`Create tag ${name}`}
      className={cn(
        'min-h-11 flex-row items-center gap-2 rounded-xl px-3 py-2.5 active:bg-muted',
        creating && 'opacity-50',
      )}
    >
      <Icon as={Plus} className="size-4 shrink-0 text-muted-foreground" />
      <Text numberOfLines={1} className="min-w-0 flex-1">
        Create “{name}”
      </Text>
    </Pressable>
  );
}
