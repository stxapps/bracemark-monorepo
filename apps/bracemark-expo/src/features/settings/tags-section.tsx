// The Tags settings section — the expo port of bracemark-web's
// `(app)/settings/[section]/_tags/tags-section.tsx` (the canonical doc: the
// lighter sibling of the Lists section — the taxonomy is deliberately FLAT, so
// no nesting UI, no depth, no "Move to"; the only shape edits are rename,
// reorder, sort, and delete, over the same one-file-per-op LWW writes).
//
// Reorder works two ways, as on web: drag by the grip, or the kebab's up/down
// (which stays the accessible fallback). The drag layer is the platform's own —
// long-press + gesture-handler/reanimated instead of dnd-kit (drag-sort.tsx) —
// but the drop is the same one-liner web's is: arrayMove the flat group and hand
// it to `reorder`. Flat means no depth projection: the horizontal axis is ignored
// entirely, so `useDragSort` gets no `indentWidth` and the drag never re-renders.

import { useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import {
  ArrowDownAZ,
  ArrowDownZA,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Pencil,
  Tag,
  Trash2,
} from 'lucide-react-native';

import { useTagMutations, useTags } from '@stxapps/expo-react';
import { arrayMove, type TagItem } from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Icon } from '../../components/ui/icon';
import { Input } from '../../components/ui/input';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { DragHandle, DragRow, type DragSort, useDragSort } from './drag-sort';
import { CreateRow } from './rows';
import { SettingsHeader, SettingsNotice, SettingsPane } from './settings-kit';

type SortDir = 'asc' | 'desc';

// Alphabetical by name, tie-broken by id — the same rule the Lists section uses.
function sortedByName(items: TagItem[], dir: SortDir): TagItem[] {
  return [...items].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return dir === 'asc' ? byName : -byName;
    return a.id.localeCompare(b.id);
  });
}

// Inline rename — the Lists section's RenameField, for a tag.
function RenameField({
  tag,
  onRename,
  inputRef,
}: {
  tag: TagItem;
  onRename: (name: string) => void;
  inputRef?: React.RefObject<TextInput | null>;
}) {
  return (
    <Input
      ref={inputRef}
      defaultValue={tag.name}
      aria-label="Tag name"
      className="h-9 border-transparent bg-transparent px-2 shadow-none"
      onEndEditing={(e) => onRename(e.nativeEvent.text)}
    />
  );
}

// The per-row overflow menu: rename, reorder within the group, delete. No
// "Move to" (flat taxonomy — nowhere to move to) and no system-tag guard
// (every tag is deletable; destroy still rejects a tag that has sub-tags,
// but none exist in the flat UI).
function RowActions({
  isFirst,
  isLast,
  onFocusName,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  isFirst: boolean;
  isLast: boolean;
  onFocusName: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pressable
          aria-label="Tag actions"
          className="size-9 items-center justify-center rounded-md"
        >
          <Icon as={MoreHorizontal} className="size-4 text-muted-foreground" />
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onPress={onFocusName}>
          <Icon as={Pencil} className="size-4" />
          <Text>Rename</Text>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={isFirst} onPress={onMoveUp}>
          <Icon as={ChevronUp} className="size-4" />
          <Text>Move up</Text>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={isLast} onPress={onMoveDown}>
          <Icon as={ChevronDown} className="size-4" />
          <Text>Move down</Text>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onPress={onDelete}>
          <Icon as={Trash2} className="size-4" />
          <Text>Delete</Text>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// One row. Flat — no indent. Reorder by dragging the grip, or by the kebab's
// up/down.
function Row({
  tag,
  index,
  drag,
  lifted,
  isFirst,
  isLast,
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  tag: TagItem;
  index: number;
  drag: DragSort;
  // This row is the one being dragged — opaque + raised while it travels.
  lifted: boolean;
  isFirst: boolean;
  isLast: boolean;
  onRename: (name: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const { pan, style, onLayout } = drag.useRow(index);
  // Focus the inline name field when Rename is picked — same deferred focus as
  // the Lists section's Row.
  const nameRef = useRef<TextInput | null>(null);
  const focusName = () => {
    setTimeout(() => nameRef.current?.focus(), 50);
  };

  return (
    <DragRow
      style={style}
      onLayout={onLayout}
      className={cn(
        'flex-row items-center gap-1 border-b border-border/60 px-1 py-1',
        lifted && 'rounded-md border-transparent bg-background',
      )}
    >
      <DragHandle pan={pan} />

      <Icon as={Tag} className="size-4 shrink-0 text-muted-foreground" />

      <View className="min-w-0 flex-1">
        <RenameField
          key={`${tag.id}:${tag.name}`}
          inputRef={nameRef}
          tag={tag}
          onRename={onRename}
        />
      </View>

      <RowActions
        isFirst={isFirst}
        isLast={isLast}
        onFocusName={focusName}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onDelete={onDelete}
      />
    </DragRow>
  );
}

export function TagsSection() {
  const tree = useTags();
  const { create, rename, move, destroy, reorder } = useTagMutations();

  const [error, setError] = useState<string | null>(null);

  // The flat, ordered tag list. `useTags` nests by `parentId`, but nothing
  // nests tags, so the top level is the whole set — take its items in rank order.
  const tags = useMemo(() => tree.map((node) => node.item), [tree]);

  // Move `tag` from `index` to `index + delta` (±1). `siblings` is the group
  // minus the moved tag, as `move` expects.
  const shift = (tag: TagItem, index: number, delta: number) => {
    const siblings = tags.filter((t) => t.id !== tag.id);
    run(move(tag, null, siblings, index + delta));
  };

  // Drag by the grip — the whole flat group, reordered. `reorder` writes only the
  // tags whose rank actually changes, so this is cheap and a no-op drop is free.
  // No indentWidth: tags don't nest, so the horizontal axis means nothing here.
  const drag = useDragSort({
    count: tags.length,
    onDrop: (from, to) => {
      if (from === to || from < 0 || to < 0) return;
      run(reorder(arrayMove(tags, from, to)));
    },
  });

  const run = (op: Promise<unknown>) => {
    setError(null);
    void op.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    // `px-4` for the same reason the Lists table uses it — see the note there.
    <SettingsPane className="px-4">
      <SettingsHeader
        title="Tags"
        description="Create, rename, and reorder your tags. Tags are flat labels — a link can have many, so there’s no nesting."
      />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      <View className="-mb-1 flex-row justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" disabled={tags.length === 0}>
              <Icon as={ArrowUpDown} className="size-4" />
              <Text>Sort</Text>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onPress={() => run(reorder(sortedByName(tags, 'asc')))}>
              <Icon as={ArrowDownAZ} className="size-4" />
              <Text>A → Z</Text>
            </DropdownMenuItem>
            <DropdownMenuItem onPress={() => run(reorder(sortedByName(tags, 'desc')))}>
              <Icon as={ArrowDownZA} className="size-4" />
              <Text>Z → A</Text>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>

      <View className="rounded-lg border border-border">
        <CreateRow
          placeholder="New tag"
          onCreate={async (name) => {
            // Not run() like the other ops: CreateRow awaits this to clear its
            // field only on success, so we surface the error here and re-throw to
            // keep the typed value.
            setError(null);
            try {
              await create(name, null, tags, 0);
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              throw e;
            }
          }}
        />

        {tags.length === 0 ? (
          <Text className="px-3 py-6 text-center text-sm text-muted-foreground">No tags yet.</Text>
        ) : (
          tags.map((tag, index) => (
            <Row
              key={tag.id}
              tag={tag}
              index={index}
              drag={drag}
              lifted={drag.activeIndex === index}
              isFirst={index === 0}
              isLast={index === tags.length - 1}
              onRename={(name) => run(rename(tag, name))}
              onMoveUp={() => shift(tag, index, -1)}
              onMoveDown={() => shift(tag, index, 1)}
              onDelete={() => run(destroy(tag))}
            />
          ))
        )}
      </View>
    </SettingsPane>
  );
}
