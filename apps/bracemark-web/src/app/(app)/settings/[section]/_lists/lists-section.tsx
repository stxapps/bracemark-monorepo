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
//
// What this file does NOT contain is everything it shares with the Tags table —
// the create row, the rename field, the sort menu, the drag grip, the error
// runner, the delete confirm — which live in `_components/table-kit.tsx`. What's left here is the
// nesting: depth, projection, "Move to", locks. That's the whole difference
// between the two sections.

import { useMemo, useState } from 'react';
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
  type AnimateLayoutChanges,
  defaultAnimateLayoutChanges,
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
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CornerUpRight,
  EyeOff,
  Folder,
  Inbox,
  KeyRound,
  Lock,
  LockOpen,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';

import {
  ARCHIVE_ID,
  deepestDepthFor,
  flattenTree,
  isSystemListId,
  LIST_NAME_MAX,
  MY_LIST_ID,
  type SortDir,
  sortedByName,
  TRASH_ID,
  type TreeNode,
} from '@stxapps/shared';
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
import { MoveToSurface } from '@stxapps/web-ui/components/links/move-to-surface';
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
import { MD_QUERY, useMediaQuery } from '@stxapps/web-ui/hooks/use-media-query';

import { SettingsHeader, SettingsNotice, SettingsPane } from '../../_components/settings-kit';
import {
  CreateRow,
  DestroyConfirm,
  DragGrip,
  RenameField,
  SortMenu,
  useDestroyRequest,
  useDropHold,
  useOpRunner,
  useRenameFocus,
  useRowMenuFocus,
} from '../../_components/table-kit';
import {
  applyMovePlan,
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

// What a dropped order is held against (table-kit's useDropHold). Depth is in it
// because a drop can re-nest a row without moving it — same ids, same sequence,
// one level over — and the depth-first sequence plus each node's depth is the
// whole forest, collapsed branches included. The expo twin's `orderKey` is this.
const treeOrder = (nodes: TreeNode<ListItem>[]) =>
  flattenTree(nodes)
    .map((node) => `${node.item.id}:${node.depth}`)
    .join(' ');

function listIcon(id: string): React.ReactNode {
  if (id === MY_LIST_ID) return <Inbox className="size-4" />;
  if (id === ARCHIVE_ID) return <Archive className="size-4" />;
  if (id === TRASH_ID) return <Trash2 className="size-4" />;
  return <Folder className="size-4" />;
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
//
// MOVE TO HAS TWO SHAPES, split at `md`, exactly as the link row menu's does.
// Above it the submenu below; under it an item that raises the section's hoisted
// MoveToSurface with the same wiring — a `w-64` submenu needs 464px beside its
// parent menu and a phone has 375 (move-to-surface.tsx carries the arithmetic
// and the keyboard half of the argument). This is also what bracemark-expo does
// at every width, since a phone is the only width it has: its MoveToDialog is
// this dialog, embedding the same ListCommand body.
function RowActions({
  row,
  wide,
  excludeIdsFor,
  lock,
  onFocusName,
  onMoveUp,
  onMoveDown,
  onMoveTo,
  onRequestMove,
  onSortChildren,
  onAddLock,
  onUnlock,
  onRemoveLock,
  onDelete,
}: {
  row: ListRow;
  // At `md` and up. Picks which shape "Move to" takes — see the header.
  wide: boolean;
  // Parent ids the row may NOT move under (forbiddenParentIds): its subtree,
  // no-children containers, and parents too deep for its subtree (the depth
  // rule). Passed to ListCommand's excludeIds. A function, asked only while this
  // menu is open: each answer walks the whole forest, and the table used to ask
  // it of every row on every render — the square of the list count, paid on
  // every drag frame.
  excludeIdsFor: () => readonly string[];
  // The row's OWN lock (lock-provider's listLocks), undefined when unlocked-able
  // — i.e. no lock exists yet.
  lock: ListLockInfo | undefined;
  onFocusName: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  // The wide path's pick, straight from the embedded ListCommand.
  onMoveTo: (parentId: string | null) => void;
  // The narrow path: no destination yet — raise the section's picker for this row.
  onRequestMove: () => void;
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
  // reason the link row menu's Move to is controlled). Only the WIDE path needs
  // this — the narrow item is an ordinary DropdownMenuItem — but the menu stays
  // controlled at both widths rather than changing kind under the breakpoint.
  const [open, setOpen] = useState(false);
  const moveTo = (parentId: string | null) => {
    onMoveTo(parentId);
    setOpen(false);
  };
  const excludeIds = useMemo(() => (open ? excludeIdsFor() : []), [open, excludeIdsFor]);

  const { triggerRef, onRenameSelect, onCloseAutoFocus } = useRowMenuFocus(onFocusName);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label="List actions"
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
        {wide ? (
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
        ) : (
          <DropdownMenuItem onSelect={onRequestMove}>
            <CornerUpRight className="size-4" /> Move to…
          </DropdownMenuItem>
        )}
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

// dnd-kit's layout animation, minus the one case it gets wrong here. A dragged
// row's subtree is dropped from the table while it travels and comes back in the
// drop's render, so every row below the new slot is suddenly further down by the
// subtree's height. Left alone, dnd-kit eases those rows there over 200ms while
// the returning children mount in place at once — two rows drawn over each other
// for the length of the slide. A row count that changed is that case exactly, so
// those rows move with the children: at once, as they do under a collapse toggle.
const animateLayoutChanges: AnimateLayoutChanges = (args) =>
  args.items.length === args.previousItems.length && defaultAnimateLayoutChanges(args);

// One sortable row. The drag handle is the grip on the left (after the indent);
// listeners live only on it, so the rename input and kebab stay clickable. While
// this row is the one being dragged, `renderDepth` is the projected depth, so the
// row visibly slides to the indent it would land at. The buttons are the same
// keyboard/mouse fallback that worked before drag existed.
function SortableRow({
  row,
  wide,
  renderDepth,
  collapsedIds,
  excludeIdsFor,
  lock,
  onToggle,
  onRename,
  onMoveUp,
  onMoveDown,
  onMoveTo,
  onRequestMove,
  onSortChildren,
  onAddLock,
  onUnlock,
  onRemoveLock,
  onDelete,
}: {
  row: ListRow;
  wide: boolean;
  renderDepth: number;
  collapsedIds: ReadonlySet<string>;
  excludeIdsFor: () => readonly string[];
  lock: ListLockInfo | undefined;
  onToggle: () => void;
  onRename: (name: string) => Promise<unknown>;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveTo: (parentId: string | null) => void;
  onRequestMove: () => void;
  onSortChildren: (dir: SortDir) => void;
  onAddLock: () => void;
  onUnlock: () => void;
  onRemoveLock: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.item.id,
    animateLayoutChanges,
  });

  const { nameRef, focusName } = useRenameFocus();

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
      <DragGrip {...attributes} {...listeners} />

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
          name={row.item.name}
          label="List name"
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
        wide={wide}
        excludeIdsFor={excludeIdsFor}
        lock={lock}
        onFocusName={focusName}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onMoveTo={onMoveTo}
        onRequestMove={onRequestMove}
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
  // The live tree, with a just-dropped move standing in for it until the live
  // read agrees (table-kit's useDropHold says why a drop can't wait for the read).
  const { shown: lists, hold } = useDropHold(useLists(), treeOrder);
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const { createTopLevel, rename, move, destroy, destroyBlocker, reorder } = useListMutations();
  const { listLocks, unlockList } = useLocks();
  const { addListLock, removeListLock } = useLockMutations();

  const { error, run, runAwait } = useOpRunner();
  // A row's Delete — checked first, then confirmed or refused in a dialog rather
  // than in the notice above the table (table-kit's useDestroyRequest says why).
  const { destroyRequest, requestDestroy, closeDestroy } = useDestroyRequest(destroyBlocker);

  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(NO_COLLAPSED_IDS);
  // The pending lock intent from a row's kebab — drives the single hoisted
  // LockPasswordDialog below (same page-level pattern as LinkDestroyConfirm).
  const [lockDialog, setLockDialog] = useState<{
    mode: 'add' | 'unlock' | 'remove';
    listId: string;
  } | null>(null);
  // The pending "Move to" intent from a row's kebab, below `md` — drives the one
  // hoisted MoveToSurface below, the same way `lockDialog` drives the password
  // one. Held as an ID, not a row: the rows are rebuilt on every list change, and
  // a stale snapshot would reparent against a tree that has moved on.
  const [movingId, setMovingId] = useState<string | null>(null);

  // One matchMedia for the section, not one per row (and settled before any menu
  // opens, so the surface can't flash the wrong container — move-to-surface.tsx).
  const wide = useMediaQuery(MD_QUERY);

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
  // The moving row is resolved against a COLLAPSE-FREE flatten, not `rows`. The
  // row was visible when its kebab opened, but the picker outlives that render:
  // a sync landing another device's reparent can slide it under a collapsed
  // ancestor, and `rows` would then stop listing it — closing the picker
  // mid-pick, for a list that still exists. Here it stays findable until the pick
  // lands (and correctly vanishes if the list is deleted elsewhere).
  // bracemark-expo's twin does the same.
  const allRows = useMemo(() => flattenToRows(lists, NO_COLLAPSED_IDS), [lists]);
  const movingRow = movingId ? allRows.find((r) => r.item.id === movingId) : undefined;
  // The row being deleted, resolved the same collapse-free way and for the same
  // reason: the dialog outlives the render its kebab opened in.
  const destroyingRow = destroyRequest
    ? allRows.find((r) => r.item.id === destroyRequest.id)
    : undefined;
  // Memoized for ListCommand, which re-walks the whole tree when `excludeIds`
  // changes identity — and this one is read on every keystroke in its filter box.
  const movingExcludeIds = useMemo(
    () => (movingRow ? [...forbiddenParentIds(lists, movingRow.item.id)] : []),
    [lists, movingRow],
  );

  // The depth the dragged row would land at, recomputed as it moves. Drives both
  // the live indent of the dragged row and the final drop.
  // The deepest the dragged row may land under the depth rule, so its live indent
  // never shows a depth the drop refuses (getMovePlan works it out again on drop).
  const activeMaxDepth = useMemo(
    () => (activeId ? deepestDepthFor(lists, activeId) : undefined),
    [lists, activeId],
  );
  const projection: Projection | null = useMemo(
    () =>
      activeId && overId
        ? getProjection(displayRows, activeId, overId, offsetLeft, {
            ...PROJECTION_OPTIONS,
            maxDepth: activeMaxDepth,
          })
        : null,
    [activeId, overId, offsetLeft, displayRows, activeMaxDepth],
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

    // Every `return` above is a drop that changes nothing: the tree stays as it
    // is and dnd-kit eases the row home. Only a write is held.
    const op = move(plan.item, plan.parentId, plan.siblings, plan.index);
    run(op);
    hold(applyMovePlan(lists, plan), op);
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

  // Reparent to the end of the destination's children. Shared by both Move-to
  // shapes (the wide submenu picks a parent inline, the narrow surface picks one
  // in a dialog), so the paywall gate and the destination maths can't drift
  // between them.
  const moveTo = (row: ListRow, parentId: string | null) => {
    setMovingId(null);
    // Moving UNDER a list nests it (the Plus lever); moving to "Top level"
    // (null) flattens and stays free — so a downgraded user can always un-nest.
    if (parentId !== null && !entitlements.nestedLists) {
      paywall.show('nestedLists');
      return;
    }
    const dest = childrenOf(lists, parentId).filter((s) => s.id !== row.item.id);
    run(move(row.item, parentId, dest, dest.length));
  };

  return (
    // NO INSET OVERRIDE HERE — and this table is why the pane HAS one to give.
    // SettingsPane is `px-4 md:px-6`, and the narrow half of that step exists for
    // this section: a row must fit a grip, a collapse toggle, an icon, a rename
    // field, lock chrome and a kebab on one line, at whatever depth the tree is
    // nested to. All of those are fixed widths and the rename field is the only
    // flexible one, so every px of gutter comes out of the field the section
    // exists to let you type in — silently, since nothing ever overflows. The 8px
    // the narrow inset gives back is half an indent step (INDENT_WIDTH is 20 here,
    // 16 on expo), so it buys most of a nesting level: on a 375px screen a locked
    // row at depth 3 leaves ~83px of text at 16 and ~67px at 24, about nine
    // characters. The only cap on depth is TREE_MAX_DEPTH (100, far past any
    // width), so the field degrades eventually either way; the inset decides how
    // soon.
    //
    // Above `md` the argument stops applying — the column caps at 672, so `px-6`
    // still leaves 624px of measure — which is the whole reason the two values
    // could move into the kit as a breakpoint. This section used to spell `px-4`
    // itself, at every width, and the cost was the topbar: it rides the same
    // column to put "Settings" on one left edge with the section title, so the
    // override put Lists and Tags 8px inside the bar. If this table ever needs the
    // narrow inset at a width the kit gives it `px-6` at, move the BREAKPOINT in
    // settings-kit.tsx and the bar follows — don't hand the section back a local
    // override, and don't widen the kit's narrow value either: that measure is
    // shared with the browser extension's options page (see
    // entrypoints/options/Shell.tsx, which cites this pane as its source).
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
        <SortMenu onSort={(dir) => sortGroup(null, dir)} />

        <div className="rounded-lg border border-border">
          {/* runAwait, not run: CreateRow awaits this to clear its field only on
              success, so the error has to surface AND re-throw. */}
          <CreateRow
            noun="list"
            maxLength={LIST_NAME_MAX}
            onCreate={(name) => runAwait(() => createTopLevel(name))}
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
                  // cycles), no-children containers, and lists too deep for it.
                  // ListCommand renders every other list (it reads useLists
                  // itself) minus these. Worked out when the row's menu opens.
                  const excludeIdsFor = () => [...forbiddenParentIds(lists, row.item.id)];
                  // The dragged row renders at its projected (would-be) depth so the
                  // indent tracks the pointer; every other row keeps its real depth.
                  const renderDepth =
                    row.item.id === activeId && projection ? projection.depth : row.depth;
                  return (
                    <SortableRow
                      key={row.item.id}
                      row={row}
                      wide={wide}
                      renderDepth={renderDepth}
                      collapsedIds={collapsedIds}
                      excludeIdsFor={excludeIdsFor}
                      lock={listLocks.get(row.item.id)}
                      onToggle={() => toggle(row.item.id)}
                      onRename={(name) => runAwait(() => rename(row.item, name))}
                      onMoveUp={() =>
                        run(move(row.item, row.parentId, siblingsWithout(row), row.index - 1))
                      }
                      onMoveDown={() =>
                        run(move(row.item, row.parentId, siblingsWithout(row), row.index + 1))
                      }
                      onMoveTo={(parentId) => moveTo(row, parentId)}
                      onRequestMove={() => setMovingId(row.item.id)}
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
                      onDelete={() => requestDestroy(row.item)}
                    />
                  );
                })}
              </ul>
            </SortableContext>
          </DndContext>
        </div>
      </div>

      {/* The narrow-width "Move to" — one instance for the whole table, like the
          lock dialog below it. The wiring is the submenu's, verbatim: the "Top
          level" target, the row's own subtree excluded, the current parent shown
          but disabled. */}
      {movingRow && (
        <MoveToSurface
          wide={wide}
          title={`Move “${movingRow.item.name}” to`}
          onOpenChange={(open) => !open && setMovingId(null)}
          value={movingRow.parentId ?? undefined}
          excludeIds={movingExcludeIds}
          disabledIds={movingRow.parentId ? [movingRow.parentId] : undefined}
          root={{
            label: 'Top level',
            selected: movingRow.parentId === null,
            onSelect: () => moveTo(movingRow, null),
          }}
          onSelect={(listId) => moveTo(movingRow, listId)}
        />
      )}

      {destroyRequest && destroyingRow && (
        <DestroyConfirm
          noun="list"
          blocker={destroyRequest.blocker}
          description={`“${destroyingRow.item.name}” will be removed from all your devices. This can’t be undone.`}
          onDestroy={() => destroy(destroyingRow.item)}
          onClose={closeDestroy}
        />
      )}

      {lockDialog?.mode === 'add' && (
        <LockPasswordDialog
          mode="create"
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
              throw new Error('Password isn’t correct. Please try again.');
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
              throw new Error('Password isn’t correct. Please try again.');
            }
          }}
        />
      )}
    </SettingsPane>
  );
}
