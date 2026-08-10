'use client';

// The Lists settings section: manage and organize the user's lists. Renders the
// same ordered tree the sidebar shows (useLists), but as editable rows — inline
// rename, reorder among siblings, reparent ("move to"), and delete — plus a
// create row at the top. Every edit goes through useListMutations, which writes
// exactly one list file per op (rank/parentId model), so this page never has to
// reason about the sync layer; it just renders the live tree and fires intents.
//
// Reorder/reparent works two ways over the same mutations: drag-and-drop (a
// grip handle with live depth projection) and buttons (up/down + a "move to"
// submenu) as the keyboard/mouse fallback, so the page stays fully usable and
// keyboard-accessible. Secondary actions live behind a per-row kebab menu rather
// than a width-measured overflow, so rows stay stable at any container width.

import { useMemo, useRef, useState } from 'react';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
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
  Archive,
  ArrowDownAZ,
  ArrowDownZA,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CornerUpRight,
  EyeOff,
  Folder,
  GripVertical,
  Inbox,
  KeyRound,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

import { ARCHIVE_ID, isSystemListId, MY_LIST_ID, TRASH_ID } from '@stxapps/shared';
import {
  type ListItem,
  type ListLockInfo,
  useEntitlements,
  useListMutations,
  useLists,
  useLockMutations,
  useLocks,
} from '@stxapps/web-react';
import { ListCommand } from '@stxapps/web-ui/components/links/list-command';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@stxapps/web-ui/components/ui/dropdown-menu';
import { Input } from '@stxapps/web-ui/components/ui/input';

import { SettingsHeader, SettingsNotice, SettingsPane } from '../../_components/settings-kit';
import {
  excludeActiveDescendants,
  getMovePlan,
  getProjection,
  INDENT_WIDTH,
  type Projection,
  PROJECTION_OPTIONS,
} from './dnd-helpers';
import { childrenOf, flattenToRows, forbiddenParentIds, type ListRow } from './tree-helpers';

import { LockPasswordDialog } from '@/components/lock-password-dialog';
import { usePaywall } from '@/contexts/paywall-provider';

const NO_COLLAPSED_IDS: ReadonlySet<string> = new Set();

type SortDir = 'asc' | 'desc';

// Alphabetical by name (case-insensitive via localeCompare), tie-broken by id so
// the order is deterministic and stable across re-sorts. `desc` flips the name
// comparison only.
function sortedByName<T extends { name: string; id: string }>(items: T[], dir: SortDir): T[] {
  return [...items].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return dir === 'asc' ? byName : -byName;
    return a.id.localeCompare(b.id);
  });
}

function listIcon(id: string): React.ReactNode {
  if (id === MY_LIST_ID) return <Inbox className="size-4" />;
  if (id === ARCHIVE_ID) return <Archive className="size-4" />;
  if (id === TRASH_ID) return <Trash2 className="size-4" />;
  return <Folder className="size-4" />;
}

// Inline rename. Uncontrolled so typing never round-trips through the store;
// commits on blur and Enter, reverts on Escape. `key`ed by the stored name in the
// parent so an external rename (another device) refreshes the field.
function RenameField({
  list,
  onRename,
  ref,
}: {
  list: ListItem;
  onRename: (name: string) => void;
  ref?: React.Ref<HTMLInputElement>;
}) {
  return (
    <Input
      ref={ref}
      defaultValue={list.name}
      aria-label="List name"
      className="h-8 border-transparent bg-transparent px-2 hover:border-border focus-visible:bg-background"
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          e.currentTarget.value = list.name;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => onRename(e.currentTarget.value)}
    />
  );
}

// The per-row overflow menu: rename, reorder within siblings, reparent, lock
// (device-local — see the LockRecord model in web-react's db.ts), delete.
// Rename just refocuses the inline RenameField (the name is edited in place, not
// in the menu) — it's here so the kebab is a complete inventory of row actions,
// since the field reads as static text until hovered. Move-to embeds the shared
// ListCommand (the same picker the link row menu's Move to and the editors use)
// with reparent-specific wiring: `root` adds the "Top level" target
// (parentId === null), `excludeIds` rules out invalid parents (the row's own
// subtree — no cycles — plus no-children containers), and the current parent
// stays visible-but-disabled. The lock items fire page-level dialog intents
// (the password prompt is one hoisted LockPasswordDialog, not per-row). Delete
// is hidden for system lists.
function RowActions({
  row,
  excludeIds,
  lock,
  onFocusName,
  onMoveUp,
  onMoveDown,
  onMoveTo,
  onSortChildren,
  onAddLock,
  onUnlock,
  onRemoveLock,
  onDelete,
}: {
  row: ListRow;
  // Parent ids the row may NOT move under (forbiddenParentIds): its subtree +
  // no-children containers. Passed to ListCommand's excludeIds.
  excludeIds: readonly string[];
  // The row's OWN lock (lock-provider's listLocks), undefined when unlocked-able
  // — i.e. no lock exists yet.
  lock: ListLockInfo | undefined;
  onFocusName: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveTo: (parentId: string | null) => void;
  onSortChildren: (dir: SortDir) => void;
  onAddLock: () => void;
  onUnlock: () => void;
  onRemoveLock: () => void;
  onDelete: () => void;
}) {
  const isFirst = row.index === 0;
  const isLast = row.index === row.siblings.length - 1;
  const deletable = !isSystemListId(row.item.id);

  // Controlled so a Move-to pick closes the menu: ListCommand selects via a
  // CommandItem, not a DropdownMenuItem, so Radix won't auto-close for it (same
  // reason the link row menu's Move to is controlled).
  const [open, setOpen] = useState(false);
  const moveTo = (parentId: string | null) => {
    onMoveTo(parentId);
    setOpen(false);
  };

  // Rename can't focus the field from onSelect: Radix closes the menu and returns
  // focus to the trigger on close (onCloseAutoFocus), which fires after us and
  // steals it back. So onSelect only records the intent, and we move focus from
  // within onCloseAutoFocus itself — preventing Radix's default trigger-refocus.
  const focusNameRequested = useRef(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="List actions">
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
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <CornerUpRight className="size-4" /> Move to
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-64 p-0">
            <ListCommand
              value={row.parentId ?? undefined}
              excludeIds={excludeIds}
              disabledIds={row.parentId ? [row.parentId] : undefined}
              root={{
                label: 'Top level',
                selected: row.parentId === null,
                onSelect: () => moveTo(null),
              }}
              onSelect={(listId) => moveTo(listId)}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {row.hasChildren && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ArrowUpDown className="size-4" /> Sort sub-lists
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => onSortChildren('asc')}>
                <ArrowDownAZ className="size-4" /> A → Z
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onSortChildren('desc')}>
                <ArrowDownZA className="size-4" /> Z → A
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator />
        {/* Lock inventory: no lock → offer one; locked → unlock (reveals a
            hidden list until reload); any lock → remove (password-gated). */}
        {lock === undefined ? (
          <DropdownMenuItem onSelect={onAddLock}>
            <Lock className="size-4" /> Lock list…
          </DropdownMenuItem>
        ) : (
          <>
            {lock.locked && (
              <DropdownMenuItem onSelect={onUnlock}>
                <LockOpen className="size-4" /> Unlock…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={onRemoveLock}>
              <KeyRound className="size-4" /> Remove lock…
            </DropdownMenuItem>
          </>
        )}
        {deletable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="size-4" /> Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The create-a-list row pinned at the top. The plus turns into a cancel once the
// field is active (focused or non-empty); a confirm (check) appears on the right.
// Confirming prepends the new list to the root group, ready to be organized.
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
        aria-label={active ? 'Cancel' : 'New list'}
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
        placeholder="New list"
        aria-label="New list name"
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
          aria-label="Create list"
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

// One sortable row. The drag handle is the grip on the left (after the indent);
// listeners live only on it, so the rename input and kebab stay clickable. While
// this row is the one being dragged, `renderDepth` is the projected depth, so the
// row visibly slides to the indent it would land at. The buttons are the same
// keyboard/mouse fallback that worked before drag existed.
function SortableRow({
  row,
  renderDepth,
  collapsedIds,
  excludeIds,
  lock,
  onToggle,
  onRename,
  onMoveUp,
  onMoveDown,
  onMoveTo,
  onSortChildren,
  onAddLock,
  onUnlock,
  onRemoveLock,
  onDelete,
}: {
  row: ListRow;
  renderDepth: number;
  collapsedIds: ReadonlySet<string>;
  excludeIds: readonly string[];
  lock: ListLockInfo | undefined;
  onToggle: () => void;
  onRename: (name: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveTo: (parentId: string | null) => void;
  onSortChildren: (dir: SortDir) => void;
  onAddLock: () => void;
  onUnlock: () => void;
  onRemoveLock: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.item.id,
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
      style={{
        // Follow the pointer vertically only — zero out x. Horizontal position is
        // the snapped indent (paddingLeft below), driven by the projected depth.
        // Letting transform.x through too would double-count the horizontal drag
        // (once here, once in the indent) and the row would smear past its level.
        transform: CSS.Translate.toString(transform ? { ...transform, x: 0 } : transform),
        transition,
        // Indent step in px (not rem) so it matches the px the drag projection
        // works in — render and projection can't drift. Base stays a rem token.
        paddingLeft: `calc(0.25rem + ${renderDepth * INDENT_WIDTH}px)`,
      }}
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

      {row.hasChildren ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsedIds.has(row.item.id) ? 'Expand' : 'Collapse'}
          onClick={onToggle}
        >
          {collapsedIds.has(row.item.id) ? (
            <ChevronRight className="size-4" />
          ) : (
            <ChevronDown className="size-4" />
          )}
        </Button>
      ) : (
        <span className="size-8 shrink-0" />
      )}

      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {listIcon(row.item.id)}
      </span>

      <div className="min-w-0 flex-1">
        <RenameField
          key={`${row.item.id}:${row.item.name}`}
          ref={nameRef}
          list={row.item}
          onRename={onRename}
        />
      </div>

      {/* Lock chrome: locked/unlocked state, plus the collapse flag while it's
          relevant (a list is only collapsed from the sidebar while locked). The
          flag declutters the sidebar only — the list stays pickable in the link
          editors, and this row is always its reveal/unlock path. */}
      {lock && (
        <span className="flex shrink-0 items-center gap-1.5 px-1 text-muted-foreground">
          {lock.hideList && lock.locked && (
            <EyeOff className="size-3.5" aria-label="Collapsed from sidebar" />
          )}
          {lock.locked ? (
            <Lock className="size-3.5" aria-label="Locked" />
          ) : (
            <LockOpen className="size-3.5" aria-label="Unlocked" />
          )}
        </span>
      )}

      <RowActions
        row={row}
        excludeIds={excludeIds}
        lock={lock}
        onFocusName={focusName}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onMoveTo={onMoveTo}
        onSortChildren={onSortChildren}
        onAddLock={onAddLock}
        onUnlock={onUnlock}
        onRemoveLock={onRemoveLock}
        onDelete={onDelete}
      />
    </li>
  );
}

export function ListsSection() {
  const lists = useLists();
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const { create, rename, move, destroy, reorder } = useListMutations();
  const { listLocks, unlockList } = useLocks();
  const { addListLock, removeListLock } = useLockMutations();

  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(NO_COLLAPSED_IDS);
  const [error, setError] = useState<string | null>(null);
  // The pending lock intent from a row's kebab — drives the single hoisted
  // LockPasswordDialog below (same page-level pattern as LinkDestroyConfirm).
  const [lockDialog, setLockDialog] = useState<{
    mode: 'add' | 'unlock' | 'remove';
    listId: string;
  } | null>(null);

  // Drag state: the row being dragged, the row it's over, and the horizontal
  // pointer offset that drives the projected depth. All null/0 when idle.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetLeft, setOffsetLeft] = useState(0);

  // A small activation distance so a click on the grip (to focus, or open nothing)
  // doesn't count as a drag; keyboard dragging gets the sortable coordinate getter.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Memoized so drag-move re-renders (which fire per frame) don't re-flatten the
  // whole tree each time — they only depend on the tree and collapse, not drag.
  const rows = useMemo(() => flattenToRows(lists, collapsedIds), [lists, collapsedIds]);
  // While dragging, the active row's subtree travels with it, so drop it out of
  // the flat list the sortable + projection see (and that we render).
  const displayRows = useMemo(() => excludeActiveDescendants(rows, activeId), [rows, activeId]);

  // The depth the dragged row would land at, recomputed as it moves. Drives both
  // the live indent of the dragged row and the final drop.
  const projection: Projection | null = useMemo(
    () =>
      activeId && overId
        ? getProjection(displayRows, activeId, overId, offsetLeft, PROJECTION_OPTIONS)
        : null,
    [activeId, overId, offsetLeft, displayRows],
  );

  const resetDnd = () => {
    setActiveId(null);
    setOverId(null);
    setOffsetLeft(0);
  };

  const handleDragStart = ({ active }: DragStartEvent) => {
    setActiveId(String(active.id));
    setOverId(String(active.id));
  };

  const handleDragMove = ({ delta, over }: DragMoveEvent) => {
    setOffsetLeft(delta.x);
    if (over) setOverId(String(over.id));
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    resetDnd();
    if (!over) return;

    const plan = getMovePlan(
      lists,
      displayRows,
      String(active.id),
      String(over.id),
      offsetLeft,
      PROJECTION_OPTIONS,
    );
    if (!plan) return;

    const current = rows.find((r) => r.item.id === plan.item.id);
    // Skip a true no-op: dropped back where it started (same parent, same slot).
    if (current && current.parentId === plan.parentId && current.index === plan.index) return;

    // Nesting (landing under a parent) is the `nestedLists` Plus lever — sibling
    // reorder at any level and flattening to the top level stay free. A free user
    // can drag to a nested slot (we don't clamp the projection), but the drop
    // routes to the paywall and the row snaps back rather than nesting.
    if (plan.parentId !== null && !entitlements.nestedLists) {
      paywall.show('nestedLists');
      return;
    }

    run(move(plan.item, plan.parentId, plan.siblings, plan.index));
  };

  const toggle = (id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const siblingsWithout = (row: ListRow) =>
    row.siblings.filter((sibling) => sibling.id !== row.item.id);

  // Sort one sibling group (root when parentId is null) alphabetically. reorder
  // writes only the rows whose rank changes, so re-sorting an ordered group is a
  // no-op.
  const sortGroup = (parentId: string | null, dir: SortDir) =>
    run(reorder(sortedByName(childrenOf(lists, parentId), dir)));

  const run = (op: Promise<unknown>) => {
    setError(null);
    void op.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <SettingsPane>
      <SettingsHeader
        title="Lists"
        description="Create, rename, reorder, and nest your lists. My List, Archive, and Trash are built in — you can rename and reorder them, but not delete them."
      />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      {/* Toolbar + the list it acts on are one block, tighter than the pane's
          rhythm — same shape as the Tags section, which is the same screen for a
          flat collection. */}
      <div className="flex flex-col gap-2">
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <ArrowUpDown className="size-4" /> Sort
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => sortGroup(null, 'asc')}>
                <ArrowDownAZ className="size-4" /> A → Z
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => sortGroup(null, 'desc')}>
                <ArrowDownZA className="size-4" /> Z → A
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="rounded-lg border border-border">
          <CreateRow
            onCreate={async (name) => {
              // Not run() like the other ops: CreateRow awaits this to clear its
              // field only on success, so we surface the error here and re-throw
              // to keep the typed value.
              setError(null);
              try {
                await create(name, null, childrenOf(lists, null), 0);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
                throw e;
              }
            }}
          />

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragMove={handleDragMove}
            onDragEnd={handleDragEnd}
            onDragCancel={resetDnd}
          >
            <SortableContext
              items={displayRows.map((row) => row.item.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul>
                {displayRows.map((row) => {
                  // Parents this row may not move under — its own subtree (no
                  // cycles) + no-children containers. ListCommand renders every
                  // other list (it reads useLists itself) minus these.
                  const excludeIds = [...forbiddenParentIds(lists, row.item.id)];
                  // The dragged row renders at its projected (would-be) depth so the
                  // indent tracks the pointer; every other row keeps its real depth.
                  const renderDepth =
                    row.item.id === activeId && projection ? projection.depth : row.depth;
                  return (
                    <SortableRow
                      key={row.item.id}
                      row={row}
                      renderDepth={renderDepth}
                      collapsedIds={collapsedIds}
                      excludeIds={excludeIds}
                      lock={listLocks.get(row.item.id)}
                      onToggle={() => toggle(row.item.id)}
                      onRename={(name) => run(rename(row.item, name))}
                      onMoveUp={() =>
                        run(move(row.item, row.parentId, siblingsWithout(row), row.index - 1))
                      }
                      onMoveDown={() =>
                        run(move(row.item, row.parentId, siblingsWithout(row), row.index + 1))
                      }
                      onMoveTo={(parentId) => {
                        // Moving UNDER a list nests it (the Plus lever); moving to
                        // "Top level" (null) flattens and stays free — so a
                        // downgraded user can always un-nest.
                        if (parentId !== null && !entitlements.nestedLists) {
                          paywall.show('nestedLists');
                          return;
                        }
                        const dest = childrenOf(lists, parentId).filter(
                          (s) => s.id !== row.item.id,
                        );
                        run(move(row.item, parentId, dest, dest.length));
                      }}
                      onSortChildren={(dir) => sortGroup(row.item.id, dir)}
                      onAddLock={() =>
                        // Gate at the affordance, before any password dialog: a free
                        // user never types a secret into a form that can't submit.
                        // Unlock/remove stay open below so a downgraded (ex-Plus)
                        // user can always reach their existing locks.
                        entitlements.locks
                          ? setLockDialog({ mode: 'add', listId: row.item.id })
                          : paywall.show('locks')
                      }
                      onUnlock={() => setLockDialog({ mode: 'unlock', listId: row.item.id })}
                      onRemoveLock={() => setLockDialog({ mode: 'remove', listId: row.item.id })}
                      onDelete={() => run(destroy(row.item))}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        </div>
      </div>

      {lockDialog?.mode === 'add' && (
        <LockPasswordDialog
          onOpenChange={(open) => !open && setLockDialog(null)}
          title="Lock list"
          description="This list will be locked on this device only. If you forget the password, sign out to remove all locks on this device."
          submitLabel="Lock"
          checkboxLabel="Also collapse this list from the sidebar while locked"
          onSubmit={async (password, hideList) => {
            await addListLock(lockDialog.listId, password, { hideList });
          }}
        />
      )}
      {lockDialog?.mode === 'unlock' && (
        <LockPasswordDialog
          onOpenChange={(open) => !open && setLockDialog(null)}
          title="Unlock list"
          description="Enter the password to unlock this list until the app reloads."
          submitLabel="Unlock"
          onSubmit={async (password) => {
            if (!(await unlockList(lockDialog.listId, password))) {
              throw new Error('Password is not correct. Please try again.');
            }
          }}
        />
      )}
      {lockDialog?.mode === 'remove' && (
        <LockPasswordDialog
          onOpenChange={(open) => !open && setLockDialog(null)}
          title="Remove lock"
          description="Enter the password to remove the lock from this list."
          submitLabel="Remove"
          onSubmit={async (password) => {
            if (!(await removeListLock(lockDialog.listId, password))) {
              throw new Error('Password is not correct. Please try again.');
            }
          }}
        />
      )}
    </SettingsPane>
  );
}
