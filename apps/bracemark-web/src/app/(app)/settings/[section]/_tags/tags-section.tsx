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

import { useMemo, useRef, useState } from 'react';
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
import {
  ArrowDownAZ,
  ArrowDownZA,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  MoreHorizontal,
  Pencil,
  Plus,
  Tag,
  Trash2,
  X,
} from 'lucide-react';

import { arrayMove } from '@stxapps/shared';
import { type TagItem, useTagMutations, useTags } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@stxapps/web-ui/components/ui/dropdown-menu';
import { Input } from '@stxapps/web-ui/components/ui/input';

import { SettingsHeader, SettingsNotice, SettingsPane } from '../../_components/settings-kit';

type SortDir = 'asc' | 'desc';

// Alphabetical by name (case-insensitive via localeCompare), tie-broken by id so
// the order is deterministic and stable across re-sorts. `desc` flips the name
// comparison only. Same rule the Lists section uses.
function sortedByName(items: TagItem[], dir: SortDir): TagItem[] {
  return [...items].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return dir === 'asc' ? byName : -byName;
    return a.id.localeCompare(b.id);
  });
}

// Inline rename. Uncontrolled so typing never round-trips through the store;
// commits on blur and Enter, reverts on Escape. `key`ed by the stored name in the
// parent so an external rename (another device) refreshes the field.
function RenameField({
  tag,
  onRename,
  ref,
}: {
  tag: TagItem;
  onRename: (name: string) => void;
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <Input
      ref={ref}
      defaultValue={tag.name}
      aria-label="Tag name"
      className="h-8 border-transparent bg-transparent px-2 hover:border-border focus-visible:bg-background"
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          e.currentTarget.value = tag.name;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => onRename(e.currentTarget.value)}
    />
  );
}

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
  // Rename can't focus the field from onSelect: Radix closes the menu and returns
  // focus to the trigger on close (onCloseAutoFocus), which fires after us and
  // steals it back. So onSelect only records the intent, and we move focus from
  // within onCloseAutoFocus itself — preventing Radix's default trigger-refocus.
  const focusNameRequested = useRef(false);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Tag actions">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(e) => {
          if (!focusNameRequested.current) return;
          focusNameRequested.current = false;
          e.preventDefault();
          onFocusName();
        }}
      >
        <DropdownMenuItem onSelect={() => (focusNameRequested.current = true)}>
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

// The create-a-tag row pinned at the top. The plus turns into a cancel once the
// field is active (focused or non-empty); a confirm (check) appears on the right.
// Confirming prepends the new tag to the group, ready to be organized. Same shape
// as the Lists section's CreateRow.
function CreateRow({ onCreate }: { onCreate: (name: string) => Promise<void> }) {
  const [value, setValue] = useState('');
  const [focused, setFocused] = useState(false);
  const active = focused || value !== '';

  const reset = () => {
    setValue('');
    setFocused(false);
  };
  const confirm = async () => {
    if (value.trim() === '') return reset();
    try {
      await onCreate(value);
      setValue('');
    } catch {
      // Keep the typed value for a retry; onCreate already surfaced the error.
    }
  };

  return (
    <div className="flex items-center gap-1 border-b border-border px-1 py-1.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={active ? 'Cancel' : 'New tag'}
        onMouseDown={(e) => {
          // mousedown (not click) so the field's blur doesn't fire first and
          // clear `active` before we can cancel.
          if (active) {
            e.preventDefault();
            reset();
          }
        }}
      >
        {active ? <X className="size-4" /> : <Plus className="size-4" />}
      </Button>
      <Input
        value={value}
        placeholder="New tag"
        aria-label="New tag name"
        className="h-8 border-transparent bg-transparent px-2 focus-visible:bg-background"
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void confirm();
          else if (e.key === 'Escape') reset();
        }}
      />
      {active && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Create tag"
          onMouseDown={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <Check className="size-4" />
        </Button>
      )}
    </div>
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
  onRename: (name: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tag.id,
  });

  // Focus (and select) the inline name field when Rename is picked. Called from
  // the menu's onCloseAutoFocus (after Radix's own trigger-refocus is prevented),
  // so a plain synchronous focus wins.
  const nameRef = useRef<HTMLInputElement>(null);
  const focusName = () => {
    nameRef.current?.focus();
    nameRef.current?.select();
  };

  return (
    <li
      ref={setNodeRef}
      className={`flex items-center gap-1 px-1 py-1 not-last:border-b not-last:border-border/60 ${isDragging ? 'opacity-50' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Drag to reorder"
        className="cursor-grab touch-none text-muted-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </Button>

      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <Tag className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <RenameField key={`${tag.id}:${tag.name}`} ref={nameRef} tag={tag} onRename={onRename} />
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
  const { create, rename, move, destroy, reorder } = useTagMutations();

  const [error, setError] = useState<string | null>(null);

  // A small activation distance so a click on the grip doesn't count as a drag;
  // keyboard dragging gets the sortable coordinate getter.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // The flat, ordered tag list. `useTags` nests by `parentId`, but nothing nests
  // tags, so the top level is the whole set — take its items in rank order.
  const tags = useMemo(() => tree.map((node) => node.item), [tree]);

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

  const run = (op: Promise<unknown>) => {
    setError(null);
    void op.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <SettingsPane>
      <SettingsHeader
        title="Tags"
        description="Create, rename, and reorder your tags. Tags are flat labels — a link can have many, so there's no nesting."
      />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      {/* The toolbar and the list it acts on are one block, so they sit tighter
          than the pane's rhythm — `Sort` belongs to the table below it, not to
          the description above it. */}
      <div className="flex flex-col gap-2">
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" disabled={tags.length === 0}>
                <ArrowUpDown className="size-4" /> Sort
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => run(reorder(sortedByName(tags, 'asc')))}>
                <ArrowDownAZ className="size-4" /> A → Z
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => run(reorder(sortedByName(tags, 'desc')))}>
                <ArrowDownZA className="size-4" /> Z → A
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="rounded-lg border border-border">
          <CreateRow
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
                      onRename={(name) => run(rename(tag, name))}
                      onMoveUp={() => shift(tag, index, -1)}
                      onMoveDown={() => shift(tag, index, 1)}
                      onDelete={() => run(destroy(tag))}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>
    </SettingsPane>
  );
}
