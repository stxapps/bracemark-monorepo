// The Lists settings section — the expo port of bracemark-web's
// `(app)/settings/[section]/_lists/lists-section.tsx` (the canonical doc:
// editable rows over the same ordered tree the sidebar shows — inline rename,
// reorder among siblings, reparent, delete, per-row locks — every edit through
// useListMutations' one-file-per-op writes). Divergences here:
//
//  - Reorder/reparent works the same two ways web's does — drag (a grip handle
//    with live depth projection) and buttons (up/down + "Move to") — but over
//    the platform's own drag layer: long-press + gesture-handler/reanimated
//    (drag-sort.tsx) instead of dnd-kit, inside the page ScrollView
//    (scroll-host.tsx) instead of a document. The MATH is literally web's: the
//    projection and the drop plan are `@stxapps/shared`'s (sync/tree-dnd.ts),
//    calibrated for touch by dnd-helpers.ts. The buttons remain the complete
//    fallback, as on web.
//  - "Move to" opens a hoisted picker DIALOG instead of web's ListCommand
//    submenu — a scrollable tree inside a nested dropdown doesn't fit a phone;
//    the dialog embeds the shared ListCommand body (components/links/
//    list-command), so the exclusion rules (forbiddenParentIds, current parent
//    disabled, "Top level" target) are web's, verbatim.
//  - Rename focuses via a ref after the menu closes (no Radix
//    onCloseAutoFocus on native).

import { useMemo, useRef, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
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
  type LucideIcon,
  MoreHorizontal,
  Pencil,
  ScanFace,
  Trash2,
} from 'lucide-react-native';

import {
  type ListLockInfo,
  useEntitlements,
  useListMutations,
  useLists,
  useLockMutations,
  useLocks,
} from '@stxapps/expo-react';
import { ARCHIVE_ID, isSystemListId, type ListItem, MY_LIST_ID, TRASH_ID } from '@stxapps/shared';

import { ListCommand } from '../../components/links/list-command';
import { LockPasswordDialog } from '../../components/lock-password-dialog';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';
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
import { usePaywall } from '../../contexts/paywall-provider';
import { cn } from '../../lib/utils';
import {
  excludeActiveDescendants,
  getMovePlan,
  getProjection,
  INDENT_WIDTH,
  PROJECTION_OPTIONS,
} from './dnd-helpers';
import { DragHandle, DragRow, type DragSort, useDragSort } from './drag-sort';
import { CreateRow } from './rows';
import { SettingsHeader, SettingsNotice, SettingsPane } from './settings-kit';
import { childrenOf, flattenToRows, forbiddenParentIds, type ListRow } from './tree-helpers';

const NO_COLLAPSED_IDS: ReadonlySet<string> = new Set();

type SortDir = 'asc' | 'desc';

// Alphabetical by name, tie-broken by id so the order is deterministic and
// stable across re-sorts — web's rule, verbatim.
function sortedByName<T extends { name: string; id: string }>(items: T[], dir: SortDir): T[] {
  return [...items].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    if (byName !== 0) return dir === 'asc' ? byName : -byName;
    return a.id.localeCompare(b.id);
  });
}

function listIcon(id: string): LucideIcon {
  if (id === MY_LIST_ID) return Inbox;
  if (id === ARCHIVE_ID) return Archive;
  if (id === TRASH_ID) return Trash2;
  return Folder;
}

// Inline rename. Uncontrolled so typing never round-trips through the store;
// commits when editing ends (blur or return). `key`ed by the stored name in the
// parent so an external rename (another device) refreshes the field.
function RenameField({
  list,
  onRename,
  inputRef,
}: {
  list: ListItem;
  onRename: (name: string) => void;
  inputRef?: React.RefObject<TextInput | null>;
}) {
  return (
    <Input
      ref={inputRef}
      defaultValue={list.name}
      aria-label="List name"
      className="h-9 border-transparent bg-transparent px-2 shadow-none"
      onEndEditing={(e) => onRename(e.nativeEvent.text)}
    />
  );
}

// The per-row overflow menu: rename, reorder within siblings, reparent, lock
// (device-local), delete — web's RowActions inventory minus its submenu
// nesting ("Move to" and "Sort sub-lists" hoist to dialogs/flat entries).
function RowActions({
  row,
  lock,
  biometricAvailable,
  biometricLabel,
  onFocusName,
  onMoveUp,
  onMoveDown,
  onMoveTo,
  onSortChildren,
  onAddLock,
  onUnlock,
  onRemoveLock,
  onToggleBiometric,
  onDelete,
}: {
  row: ListRow;
  // The row's OWN lock (lock-provider's listLocks), undefined when none exists.
  lock: ListLockInfo | undefined;
  // Device biometry usable here, and its label — gate + copy for the toggle.
  biometricAvailable: boolean;
  biometricLabel: string;
  onFocusName: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveTo: () => void;
  onSortChildren: (dir: SortDir) => void;
  onAddLock: () => void;
  onUnlock: () => void;
  onRemoveLock: () => void;
  onToggleBiometric: () => void;
  onDelete: () => void;
}) {
  const isFirst = row.index === 0;
  const isLast = row.index === row.siblings.length - 1;
  const deletable = !isSystemListId(row.item.id);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Pressable
          aria-label="List actions"
          className="size-9 items-center justify-center rounded-md"
        >
          <Icon as={MoreHorizontal} className="size-4 text-muted-foreground" />
        </Pressable>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
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
        <DropdownMenuItem onPress={onMoveTo}>
          <Icon as={CornerUpRight} className="size-4" />
          <Text>Move to…</Text>
        </DropdownMenuItem>
        {row.hasChildren && (
          <>
            <DropdownMenuItem onPress={() => onSortChildren('asc')}>
              <Icon as={ArrowDownAZ} className="size-4" />
              <Text>Sort sub-lists A → Z</Text>
            </DropdownMenuItem>
            <DropdownMenuItem onPress={() => onSortChildren('desc')}>
              <Icon as={ArrowDownZA} className="size-4" />
              <Text>Sort sub-lists Z → A</Text>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        {/* Lock inventory: no lock → offer one; locked → unlock (reveals a
            hidden list until relaunch); any lock → remove (password-gated). */}
        {lock === undefined ? (
          <DropdownMenuItem onPress={onAddLock}>
            <Icon as={Lock} className="size-4" />
            <Text>Lock list…</Text>
          </DropdownMenuItem>
        ) : (
          <>
            {lock.locked && (
              <DropdownMenuItem onPress={onUnlock}>
                <Icon as={LockOpen} className="size-4" />
                <Text>Unlock…</Text>
              </DropdownMenuItem>
            )}
            {/* Biometric opt-in for this lock — a free convenience toggle over
                the existing password (docs/locks.md). Enabling runs one OS
                confirm; the password stays the fallback. */}
            {biometricAvailable && (
              <DropdownMenuItem onPress={onToggleBiometric}>
                <Icon as={ScanFace} className="size-4" />
                <Text>
                  {lock.biometric ? `Disable ${biometricLabel}` : `Enable ${biometricLabel}`}
                </Text>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onPress={onRemoveLock}>
              <Icon as={KeyRound} className="size-4" />
              <Text>Remove lock…</Text>
            </DropdownMenuItem>
          </>
        )}
        {deletable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onPress={onDelete}>
              <Icon as={Trash2} className="size-4" />
              <Text>Delete</Text>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// One row. Indented by depth. Reorder/reparent by dragging the grip (the row
// slides between indents as the projection changes) or by the kebab's up/down +
// "Move to…".
function Row({
  row,
  dragIndex,
  drag,
  lifted,
  collapsedIds,
  lock,
  biometricAvailable,
  biometricLabel,
  onToggle,
  onRename,
  onMoveUp,
  onMoveDown,
  onMoveTo,
  onSortChildren,
  onAddLock,
  onUnlock,
  onRemoveLock,
  onToggleBiometric,
  onDelete,
}: {
  row: ListRow;
  // The row's position in the flat, currently-rendered list — what the drag
  // layer counts in (NOT `row.index`, which is the position among siblings).
  dragIndex: number;
  drag: DragSort;
  // This row is the one being dragged — opaque + raised while it travels.
  lifted: boolean;
  collapsedIds: ReadonlySet<string>;
  lock: ListLockInfo | undefined;
  biometricAvailable: boolean;
  biometricLabel: string;
  onToggle: () => void;
  onRename: (name: string) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onMoveTo: () => void;
  onSortChildren: (dir: SortDir) => void;
  onAddLock: () => void;
  onUnlock: () => void;
  onRemoveLock: () => void;
  onToggleBiometric: () => void;
  onDelete: () => void;
}) {
  // Focus the inline name field when Rename is picked from the kebab. The menu
  // closes on select; defer one beat so focus isn't stolen by its teardown.
  const nameRef = useRef<TextInput | null>(null);
  const focusName = () => {
    setTimeout(() => nameRef.current?.focus(), 50);
  };

  const { pan, style, onLayout } = drag.useRow(dragIndex);

  return (
    <DragRow
      onLayout={onLayout}
      className={cn(
        'flex-row items-center gap-1 border-b border-border/60 px-1 py-1',
        lifted && 'rounded-md border-transparent bg-background',
      )}
      // The indent in px (not a class) so it matches the px the drag projection
      // works in — render and projection can't drift. The animated style rides on
      // top: while this row is the lifted one it slides horizontally by whole
      // indents as the projected depth changes.
      style={[row.depth > 0 ? { paddingLeft: 4 + row.depth * INDENT_WIDTH } : null, style]}
    >
      <DragHandle pan={pan} />

      {row.hasChildren ? (
        <Pressable
          aria-label={collapsedIds.has(row.item.id) ? 'Expand' : 'Collapse'}
          className="size-9 items-center justify-center rounded-md"
          onPress={onToggle}
        >
          <Icon
            as={collapsedIds.has(row.item.id) ? ChevronRight : ChevronDown}
            className="size-4 text-muted-foreground"
          />
        </Pressable>
      ) : (
        <View className="size-9 shrink-0" />
      )}

      <Icon as={listIcon(row.item.id)} className="size-4 shrink-0 text-muted-foreground" />

      <View className="min-w-0 flex-1">
        <RenameField
          key={`${row.item.id}:${row.item.name}`}
          inputRef={nameRef}
          list={row.item}
          onRename={onRename}
        />
      </View>

      {/* Lock chrome: locked/unlocked state, plus the collapse flag while it's
          relevant (a list is only hidden from the sidebar while locked). */}
      {lock && (
        <View className="shrink-0 flex-row items-center gap-1.5 px-1">
          {lock.hideList && lock.locked && (
            <Icon
              as={EyeOff}
              className="size-3.5 text-muted-foreground"
              aria-label="Hidden from sidebar"
            />
          )}
          {lock.locked ? (
            <Icon as={Lock} className="size-3.5 text-muted-foreground" aria-label="Locked" />
          ) : (
            <Icon as={LockOpen} className="size-3.5 text-muted-foreground" aria-label="Unlocked" />
          )}
        </View>
      )}

      <RowActions
        row={row}
        lock={lock}
        biometricAvailable={biometricAvailable}
        biometricLabel={biometricLabel}
        onFocusName={focusName}
        onMoveUp={onMoveUp}
        onMoveDown={onMoveDown}
        onMoveTo={onMoveTo}
        onSortChildren={onSortChildren}
        onAddLock={onAddLock}
        onUnlock={onUnlock}
        onRemoveLock={onRemoveLock}
        onToggleBiometric={onToggleBiometric}
        onDelete={onDelete}
      />
    </DragRow>
  );
}

// The hoisted "Move to" picker — the dialog stand-in for web's ListCommand
// submenu, embedding the same shared ListCommand body
// (components/links/list-command): "Top level" first (the `root` opt-in),
// then every list at its tree indent, minus the forbidden parents (the row's
// own subtree, no-children containers); the current parent shows but is
// disabled — `value`/`disabledIds`/`root`, exactly web's reparent-menu
// wiring. ListCommand reads the live tree itself, full and collapse-free, so
// every candidate parent shows.
function MoveToDialog({
  row,
  excludeIds,
  onSelect,
  onClose,
}: {
  row: ListRow;
  excludeIds: ReadonlySet<string>;
  onSelect: (parentId: string | null) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-full max-w-sm">
        <DialogHeader>
          <DialogTitle>Move “{row.item.name}” to</DialogTitle>
        </DialogHeader>
        <ListCommand
          value={row.parentId ?? undefined}
          excludeIds={[...excludeIds]}
          disabledIds={row.parentId !== null ? [row.parentId] : undefined}
          root={{
            label: 'Top level',
            selected: row.parentId === null,
            onSelect: () => onSelect(null),
          }}
          onSelect={onSelect}
        />
      </DialogContent>
    </Dialog>
  );
}

export function ListsSection() {
  const lists = useLists();
  const { entitlements } = useEntitlements();
  const paywall = usePaywall();
  const { create, rename, move, destroy, reorder } = useListMutations();
  const { listLocks, unlockList, biometricAvailable, biometricLabel } = useLocks();
  const { addListLock, removeListLock, setListBiometric } = useLockMutations();

  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(NO_COLLAPSED_IDS);
  const [error, setError] = useState<string | null>(null);
  // The pending lock intent from a row's kebab — drives the single hoisted
  // LockPasswordDialog below (web's page-level pattern).
  const [lockDialog, setLockDialog] = useState<{
    mode: 'add' | 'unlock' | 'remove';
    listId: string;
  } | null>(null);
  // The pending "Move to" intent — drives the hoisted MoveToDialog.
  const [movingId, setMovingId] = useState<string | null>(null);
  // The row currently being dragged, by id. Only the exclusion below and the
  // lifted row's styling read it — the drag's own animation never re-renders.
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const rows = useMemo(() => flattenToRows(lists, collapsedIds), [lists, collapsedIds]);
  // While dragging, the lifted row's subtree travels with it, so drop it out of
  // the flat list the drag layer and the projection see (and that we render) —
  // a row can't be dropped inside its own children. Web does exactly this.
  const displayRows = useMemo(() => excludeActiveDescendants(rows, draggingId), [rows, draggingId]);
  // The moving row must be findable regardless of collapse state (its own
  // ancestors may be collapsed); the picker's rows are ListCommand's own read.
  const allRows = useMemo(() => flattenToRows(lists, NO_COLLAPSED_IDS), [lists]);
  const movingRow = movingId ? allRows.find((r) => r.item.id === movingId) : undefined;

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
  // writes only the rows whose rank changes, so re-sorting an ordered group is
  // a no-op.
  const sortGroup = (parentId: string | null, dir: SortDir) =>
    run(reorder(sortedByName(childrenOf(lists, parentId), dir)));

  const run = (op: Promise<unknown>) => {
    setError(null);
    void op.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

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

  // The drag surface. Everything smooth about it runs on the UI thread inside
  // drag-sort.tsx; what lands here is only the discrete half — "which slot, and
  // how far right?" — answered by the SAME shared projection web's dnd-kit layer
  // calls, so nesting behaves identically on both platforms.
  const drag = useDragSort({
    count: displayRows.length,
    indentWidth: INDENT_WIDTH,
    onPickUp: (index) => setDraggingId(displayRows[index]?.item.id ?? null),
    onRelease: () => setDraggingId(null),
    // Mid-drag: how far the lifted row should slide horizontally, i.e. the
    // difference between the depth it would land at and its own. Fires only when
    // the slot or the horizontal bucket changes, not per frame.
    projectOffsetX: (to, offsetX) => {
      const over = displayRows[to];
      const active = displayRows.find((r) => r.item.id === draggingId);
      // The first call can arrive before `draggingId`'s render lands; the offset
      // is 0 at that point anyway.
      if (!over || !active) return 0;
      const { depth } = getProjection(
        displayRows,
        active.item.id,
        over.item.id,
        offsetX,
        PROJECTION_OPTIONS,
      );
      return (depth - active.depth) * INDENT_WIDTH;
    },
    onDrop: (from, to, offsetX) => {
      const active = displayRows[from];
      const over = displayRows[to];
      if (!active || !over) return;

      const plan = getMovePlan(
        lists,
        displayRows,
        active.item.id,
        over.item.id,
        offsetX,
        PROJECTION_OPTIONS,
      );
      if (!plan) return;

      const current = rows.find((r) => r.item.id === plan.item.id);
      // Skip a true no-op: dropped back where it started (same parent, same slot).
      if (current && current.parentId === plan.parentId && current.index === plan.index) return;

      // Nesting (landing under a parent) is the `nestedLists` Plus lever — sibling
      // reorder at any level and flattening to the top level stay free. A free
      // user can drag to a nested slot (the projection isn't clamped), but the
      // drop routes to the paywall and the row snaps back rather than nesting.
      if (plan.parentId !== null && !entitlements.nestedLists) {
        paywall.show('nestedLists');
        return;
      }

      run(move(plan.item, plan.parentId, plan.siblings, plan.index));
    },
  });

  return (
    // `px-4`, one step tighter than the pane's own `px-6`: the table below is a
    // DRAG surface, and every pixel of inset is a pixel a dragged row has to
    // travel before it clears the edge. The vertical rhythm and the max-w-2xl
    // measure still come from the pane, so this is the only axis that differs.
    <SettingsPane className="px-4">
      <SettingsHeader
        title="Lists"
        description="Create, rename, reorder, and nest your lists. My List, Archive, and Trash are built in — you can rename and reorder them, but not delete them."
      />

      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      <View className="-mb-1 flex-row justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm">
              <Icon as={ArrowUpDown} className="size-4" />
              <Text>Sort</Text>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onPress={() => sortGroup(null, 'asc')}>
              <Icon as={ArrowDownAZ} className="size-4" />
              <Text>A → Z</Text>
            </DropdownMenuItem>
            <DropdownMenuItem onPress={() => sortGroup(null, 'desc')}>
              <Icon as={ArrowDownZA} className="size-4" />
              <Text>Z → A</Text>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>

      <View className="rounded-lg border border-border">
        <CreateRow
          placeholder="New list"
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

        {displayRows.map((row, index) => (
          <Row
            key={row.item.id}
            row={row}
            dragIndex={index}
            drag={drag}
            lifted={row.item.id === draggingId}
            collapsedIds={collapsedIds}
            lock={listLocks.get(row.item.id)}
            biometricAvailable={biometricAvailable}
            biometricLabel={biometricLabel}
            onToggle={() => toggle(row.item.id)}
            onRename={(name) => run(rename(row.item, name))}
            onMoveUp={() => run(move(row.item, row.parentId, siblingsWithout(row), row.index - 1))}
            onMoveDown={() =>
              run(move(row.item, row.parentId, siblingsWithout(row), row.index + 1))
            }
            onMoveTo={() => setMovingId(row.item.id)}
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
            onToggleBiometric={() =>
              // A free convenience flag on an existing lock (creating the lock was
              // the paywalled step), so no entitlement gate here.
              run(setListBiometric(row.item.id, !(listLocks.get(row.item.id)?.biometric ?? false)))
            }
            onDelete={() => run(destroy(row.item))}
          />
        ))}
      </View>

      {movingRow && (
        <MoveToDialog
          row={movingRow}
          excludeIds={forbiddenParentIds(lists, movingRow.item.id)}
          onSelect={(parentId) => moveTo(movingRow, parentId)}
          onClose={() => setMovingId(null)}
        />
      )}

      {lockDialog?.mode === 'add' && (
        <LockPasswordDialog
          onOpenChange={(open) => !open && setLockDialog(null)}
          title="Lock list"
          description="This list will be locked on this device only. If you forget the password, sign out to remove all locks on this device."
          submitLabel="Lock"
          checkboxLabel="Also hide this list from the sidebar while locked"
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
