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

export type TagPickerRow = {
  id: string;
  name: string;
  selected: boolean;
};

export function TagPickerRows({
  rows,
  onToggle,
  emptyText,
  createName,
  creating = false,
  onCreate,
  testIDForRow,
  createTestID,
}: {
  rows: TagPickerRow[];
  onToggle: (id: string) => void;
  emptyText?: string;
  createName?: string;
  creating?: boolean;
  onCreate?: () => void;
  testIDForRow?: (row: TagPickerRow) => string | undefined;
  createTestID?: string;
}) {
  return (
    <>
      {rows.length === 0 && createName === undefined && emptyText !== undefined && (
        <Text className="px-2 py-2.5 text-sm text-muted-foreground">{emptyText}</Text>
      )}

      {rows.map((row) => (
        <Pressable
          key={row.id}
          testID={testIDForRow?.(row)}
          onPress={() => onToggle(row.id)}
          role="checkbox"
          aria-checked={row.selected}
          aria-label={row.name}
          className="min-h-11 flex-row items-center justify-between gap-2 rounded-xl px-2 py-2.5 active:bg-muted"
        >
          <Text numberOfLines={1} className="min-w-0 flex-1">
            {row.name}
          </Text>
          <View className="size-4 shrink-0 items-center justify-center">
            {row.selected && <Icon as={Check} className="size-4 text-muted-foreground" />}
          </View>
        </Pressable>
      ))}

      {createName !== undefined && onCreate !== undefined && (
        <Pressable
          testID={createTestID}
          disabled={creating}
          onPress={onCreate}
          role="button"
          aria-label={`Create tag ${createName}`}
          className={cn(
            'min-h-11 flex-row items-center gap-2 rounded-xl px-2 py-2.5 active:bg-muted',
            creating && 'opacity-50',
          )}
        >
          <Icon as={Plus} className="size-4 shrink-0 text-muted-foreground" />
          <Text numberOfLines={1} className="min-w-0 flex-1">
            Create “{createName}”
          </Text>
        </Pressable>
      )}
    </>
  );
}
