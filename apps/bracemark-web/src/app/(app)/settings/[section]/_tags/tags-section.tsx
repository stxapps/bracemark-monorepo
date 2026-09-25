'use client';

// The Tags settings section: manage the user's tags. The lighter sibling of the
// Lists section — tags share the exact same rank/parentId entity and mutations,
// but the taxonomy is deliberately FLAT here: a tag is a label ("what it's
// about"), not a location, so there's no nesting UI, no depth projection, no
// "Move to". Every tag is one root-level sibling; the only shape edits are
// rename, reorder (drag or up/down), sort, and delete.
//
// Because no surface nests tags, `useTags`'s top level is the full set (buildTree
// also promotes any dangling parent to root), so we render it as one ranked
// group. Every mutation targets `parentId: null` over that single group — the
// same one-file-per-op LWW writes the Lists section makes, so this page never
// reasons about the sync layer; it renders the live list and fires intents.
//
// What this file does NOT contain is everything it shares with the Lists table —
// the create row, the rename field, the sort menu, the drag grip, the error
// runner, the delete confirm — which live in `_components/table-kit.tsx`. What's left here is the
// flatness: that's the whole difference between the two sections.

import { useMemo } from 'react';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronUp, MoreHorizontal, Pencil, Tag, Trash2 } from 'lucide-react';

import { arrayMove, sortedByName } from '@stxapps/shared';
import { type TagItem, useTagMutations, useTags } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@stxapps/web-ui/components/ui/dropdown-menu';

import { SettingsHeader, SettingsNotice, SettingsPane } from '../../_components/settings-kit';
import {
  CreateRow,
  DestroyConfirm,
  DragGrip,
  RenameField,
  SortMenu,
  useDestroyRequest,
  useOpRunner,
  useRenameFocus,
  useRowMenuFocus,
} from '../../_components/table-kit';

// The per-row overflow menu: rename, reorder within the group, delete. Rename
// just refocuses the inline RenameField (the name is edited in place, not in the
// menu) — it's here so the kebab is a complete inventory of row actions, since the
// field reads as static text until hovered. No "Move to" (flat taxonomy — nowhere
// to move to) and no system-tag guard (every tag is deletable; destroy still
// rejects a tag that has sub-tags, but none exist in the flat UI).
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
  const { triggerRef, onRenameSelect, onCloseAutoFocus } = useRowMenuFocus(onFocusName);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label="Tag actions"
        >
          {/* 20 in a 32px box and muted at rest — the same trigger the link rows
              render, which is where both halves of the reasoning live
              (link-row-menu.tsx): the optical correction is a fact about the
              glyph rather than of the surface it sits on, and the ⋯ is chrome
              until you go looking for it, so it doesn't compete with the row's
              name at full `text-foreground`. `ghost` hands that back on hover and
              for as long as the menu is open. */}
          <MoreHorizontal className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={onCloseAutoFocus}>
        <DropdownMenuItem onSelect={onRenameSelect}>
          <Pencil className="size-4" /> Rename
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={isFirst} onSelect={onMoveUp}>
          <ChevronUp className="size-4" /> Move up
        </DropdownMenuItem>
        <DropdownMenuItem disabled={isLast} onSelect={onMoveDown}>
          <ChevronDown className="size-4" /> Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-4" /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// One sortable row. The drag handle is the grip on the left; listeners live only
// on it, so the rename input and kebab stay clickable. Flat — no indent, no depth
// projection: dragging only reorders within the single group. The up/down buttons
// are the keyboard/mouse fallback.
function SortableRow({
  tag,
  isFirst,
  isLast,
  onRename,
  onMoveUp,
  onMoveDown,
  onDelete,
}: {
  tag: TagItem;
  isFirst: boolean;
  isLast: boolean;
  onRename: (name: string) => Promise<unknown>;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tag.id,
  });

  const { nameRef, focusName } = useRenameFocus();

  return (
    <li
      ref={setNodeRef}
      className={`flex items-center gap-1 px-1 py-1 not-last:border-b not-last:border-border/60 ${isDragging ? 'opacity-50' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <DragGrip {...attributes} {...listeners} />

      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <Tag className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <RenameField
          key={`${tag.id}:${tag.name}`}
          ref={nameRef}
          name={tag.name}
          label="Tag name"
          onRename={onRename}
        />
      </div>

      <RowActions
        isFirst={isFirst}
        isLast={isLast}
        onFocusName={focusName}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onDelete={onDelete}
      />
    </li>
  );
}

export function TagsSection() {
  const tree = useTags();
  const { create, rename, move, destroy, destroyBlocker, reorder } = useTagMutations();

  const { error, run, runAwait } = useOpRunner();
  // A row's Delete — checked first, then confirmed or refused in a dialog rather
  // than in the notice above the table (table-kit's useDestroyRequest says why).
  const { destroyRequest, requestDestroy, closeDestroy } = useDestroyRequest(destroyBlocker);

  // A small activation distance so a click on the grip doesn't count as a drag;
  // keyboard dragging gets the sortable coordinate getter.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // The flat, ordered tag list. `useTags` nests by `parentId`, but nothing nests
  // tags, so the top level is the whole set — take its items in rank order.
  const tags = useMemo(() => tree.map((node) => node.item), [tree]);
  // Resolved against the live list, so a tag deleted elsewhere closes its dialog.
  const destroyingTag = destroyRequest ? tags.find((t) => t.id === destroyRequest.id) : undefined;

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;

    const oldIndex = tags.findIndex((t) => t.id === active.id);
    const newIndex = tags.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    // reorder writes only the tags whose rank actually changes, so this is cheap.
    run(reorder(arrayMove(tags, oldIndex, newIndex)));
  };

  // Move `tag` from `index` to `index + delta` (±1). `siblings` is the group
  // minus the moved tag, as `move` expects.
  const shift = (tag: TagItem, index: number, delta: number) => {
    const siblings = tags.filter((t) => t.id !== tag.id);
    run(move(tag, null, siblings, index + delta));
  };

  return (
    // No inset override — the pane's own `px-4 md:px-6` is the inset, on this
    // section and every other. This table never needed the narrow half: it is
    // flat, so a row is a grip, an icon, a rename field and a kebab with no indent
    // to pay for, and the field has width to spare either way. It used to carry a
    // hard `px-4` anyway, to stay the same screen as Lists — which is now the
    // kit's job, and got both tables back onto the topbar's left edge. The
    // argument for the narrow value lives at _lists/lists-section.tsx's pane,
    // where it is earned.
    <SettingsPane>
      <SettingsHeader
        title="Tags"
        description="Create, rename, and reorder your tags. A link can have several tags; tags do not nest."
      />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      {/* The toolbar and the list it acts on are one block, so they sit tighter
          than the pane's rhythm — `Sort` belongs to the table below it, not to
          the description above it. */}
      <div className="flex flex-col gap-2">
        <SortMenu
          disabled={tags.length === 0}
          onSort={(dir) => run(reorder(sortedByName(tags, dir)))}
        />

        <div className="rounded-lg border border-border">
          {/* runAwait, not run: CreateRow awaits this to clear its field only on
              success, so the error has to surface AND re-throw. */}
          <CreateRow noun="tag" onCreate={(name) => runAwait(() => create(name, null, tags, 0))} />

          {tags.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No tags yet.</p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={tags.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <ul>
                  {tags.map((tag, index) => (
                    <SortableRow
                      key={tag.id}
                      tag={tag}
                      isFirst={index === 0}
                      isLast={index === tags.length - 1}
                      onRename={(name) => runAwait(() => rename(tag, name))}
                      onMoveUp={() => shift(tag, index, -1)}
                      onMoveDown={() => shift(tag, index, 1)}
                      onDelete={() => requestDestroy(tag)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

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
