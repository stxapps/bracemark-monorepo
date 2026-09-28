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
//
// What this file does NOT contain is everything it shares with the Lists table —
// the create row, the rename field, the sort menu, the error runner, the delete
// confirm — which live in table-kit.tsx. What's left here is the flatness: that's the whole difference
// between the two sections.

import { useMemo } from 'react';
import { View } from 'react-native';
import { ChevronDown, ChevronUp, MoreHorizontal, Pencil, Tag, Trash2 } from 'lucide-react-native';

import { useTagMutations, useTags } from '@stxapps/expo-react';
import { arrayMove, sortedByName, type TagItem } from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { DragHandle, DragRow, type DragSort, useDragSort } from './drag-sort';
import { SettingsHeader, SettingsNotice, SettingsPane } from './settings-kit';
import {
  CreateRow,
  DestroyConfirm,
  RenameField,
  SortMenu,
  useDestroyRequest,
  useOpRunner,
  useRenameFocus,
} from './table-kit';

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
        <Button variant="ghost" size="icon-sm" aria-label="Tag actions">
          {/* 20, as every ⋯ trigger in both apps is — see link-row-menu.tsx. */}
          <Icon as={MoreHorizontal} className="size-5 text-muted-foreground" />
        </Button>
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
  onRename: (name: string) => Promise<unknown>;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const { pan, style, onLayout } = drag.useRow(index);
  const { nameRef, focusName } = useRenameFocus();

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
          name={tag.name}
          label="Tag name"
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
  const { create, rename, move, destroy, destroyBlocker, reorder } = useTagMutations();

  const { error, run, runAwait } = useOpRunner();
  // A row's Delete — checked first, then confirmed or refused in a dialog rather
  // than in the notice above the table (table-kit's useDestroyRequest says why).
  const { destroyRequest, requestDestroy, closeDestroy } = useDestroyRequest(destroyBlocker);

  // The flat, ordered tag list. `useTags` nests by `parentId`, but nothing
  // nests tags, so the top level is the whole set — take its items in rank order.
  const tags = useMemo(() => tree.map((node) => node.item), [tree]);
  // Resolved against the live list, so a tag deleted elsewhere closes its dialog.
  const destroyingTag = destroyRequest ? tags.find((t) => t.id === destroyRequest.id) : undefined;

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

  return (
    // No inset override — the pane's own `px-4 md:px-6` is the inset, on this
    // section and every other. This table never needed the narrow half: it is
    // flat, so a row has no indent to pay for, and on a 375pt screen the name field
    // gets ~217px at 16 against ~201px at 24 — ample either way. It used to carry a
    // hard `px-4` regardless, to stay the same screen as Lists, which is now the
    // kit's job. The argument for the narrow value lives at the head of
    // lists-section.tsx's pane, where it is earned.
    <SettingsPane>
      <SettingsHeader
        title="Tags"
        description="Create, rename, and reorder your tags. A link can have several tags; tags don’t nest."
      />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      <SortMenu
        disabled={tags.length === 0}
        onSort={(dir) => run(reorder(sortedByName(tags, dir)))}
      />

      <View className="rounded-lg border border-border">
        {/* runAwait, not run: CreateRow awaits this to clear its field only on
            success, so the error has to surface AND re-throw. */}
        <CreateRow noun="tag" onCreate={(name) => runAwait(() => create(name, null, tags, 0))} />

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
              onRename={(name) => runAwait(() => rename(tag, name))}
              onMoveUp={() => shift(tag, index, -1)}
              onMoveDown={() => shift(tag, index, 1)}
              onDelete={() => requestDestroy(tag)}
            />
          ))
        )}
      </View>

      {destroyRequest && destroyingTag && (
        <DestroyConfirm
          noun="tag"
          blocker={destroyRequest.blocker}
          description={`“${destroyingTag.name}” will be removed from every link that has it, on all your devices. This can’t be undone.`}
          onDestroy={() => destroy(destroyingTag)}
          onClose={closeDestroy}
        />
      )}
    </SettingsPane>
  );
}
