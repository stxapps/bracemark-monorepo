// The bottom-anchored action bar shown while bulk-edit mode is on — the expo
// port of bracemark-web's BulkEditToolbar (`(app)/links/_components/
// bulk-edit-toolbar.tsx`, the canonical doc for the action semantics: the
// view-keyed button set, the `actionable` trashed-links filter, why each action
// drops links already in its target state, one bulk action at a time, every
// completed WRITE exits the mode and why Copy is the exception that doesn't).
// It acts on the hoisted `selectedLinks` snapshot map; the one thing it takes
// from outside is `links` — the rows Main is showing — which feeds Select all
// and puts the copied URLs in display order. Divergences here:
//
//  - Bottom-anchored (thumb reach), not a row under the topbar; the dismiss ✕ /
//    count / Select all live in its top row, the actions below — web's
//    left-cluster/right-cluster split becomes a two-row split.
//  - The secondary actions (Edit tags, Pin, Unpin, Archive) sit behind a ⋯ menu
//    at EVERY width — web collapses them below a measured 900px, and a phone is
//    always below it, so the split is fixed rather than measured. Copy, Move to,
//    and the destructive Remove stay inline, exactly web's collapsed set.
//  - Below the wide window (768, `useWideWindow`), those inline actions are
//    GLYPHS with no label — web's second tier, the icon-only one below its
//    measured 560px. They carried labels once, and the row was wider than a
//    narrow Android phone: Button is `shrink-0`, so the surplus pushed Remove
//    past the right edge, further while Copy read "Copied" or the font scale was
//    raised. Each name lives in `aria-label` there, busy and "Copied" wording
//    included. Unlike web's squares the glyphs share the row (`flex-1`): this
//    bar gives the actions a row of their own, and a 36dp square is a small
//    target for a thumb to tell Remove from the ⋯ beside it.
//  - On a wide window they get their labels back, sized to their content and
//    gathered at the row's end — web's labelled tier, with Remove on the outer
//    edge where web puts it. Stretched across a tablet's pane, four `flex-1`
//    glyphs were ~240dp boxes that said nothing. The switch is the window's
//    768, not web's measured 560 — the app's one layout number
//    (docs/safe-area.md, _wide windows on native_) — and it holds at the
//    narrowest wide pane: 768 less the docked rail leaves 488, and the labelled
//    set takes ~335 of it at 1× and still fits at 1.5×. Web's 900 tier, the ⋯
//    items inline, would not (another ~380), so the ⋯ menu stays at every
//    width.
//  - Select all is a plain boolean checkbox — the reusables Checkbox has no
//    indeterminate (same note as the search editor's tri-state rows), so a
//    partial selection just shows unchecked; pressing it then selects all.
//  - Copy links writes through expo-clipboard (web's navigator.clipboard), with
//    the same transient flip to a check as the only feedback — the GLYPH, for
//    web's reason: no label is rendered to flip (the accessible name flips to
//    "Copied" with it). It is also the confirmation ShowOnceSecret already uses
//    on this platform (features/auth/show-once-secret.tsx), so the app confirms
//    a copy one way.
//  - Move to opens a Dialog listing the list tree (the anchored ListCommand
//    popover doesn't fit a phone; the picker excludes Trash like web — trashing
//    is Remove, never a "move" — and carries the same Create row, so the
//    selection can be filed into a list made on the spot: move-to-dialog.tsx).
//  - Android back exits the mode before it navigates (the same platform
//    cascade as the search bar's close-before-navigate).
//
// Pin/Unpin split the selection against a LIVE pin read (useLiveRead over
// readPins), so a pin landing from another device mid-selection is accounted
// for — web's useLiveQuery(readPins), verbatim in spirit.

import { type ComponentProps, useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import * as Clipboard from 'expo-clipboard';
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  FolderInput,
  type LucideIcon,
  MoreHorizontal,
  Pin,
  PinOff,
  Tags,
  Trash2,
  Undo2,
  X,
} from 'lucide-react-native';

import {
  linkIdOf,
  type LinkView,
  readPins,
  useLinkMutations,
  useLiveRead,
  usePinMutations,
} from '@stxapps/expo-react';
import { ARCHIVE_ID, DEFAULT_LIST_ID, TRASH_ID } from '@stxapps/shared';

import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { cn } from '../../lib/utils';
import { useWideWindow } from '../../lib/window-class';
import { MoveToDialog } from './move-to-dialog';
import { useLinksPage } from './page-provider';
import { useLinksViewState } from './view-state-provider';

type BulkAction = 'restore' | 'move' | 'pin' | 'unpin' | 'archive' | 'remove';

// Every target in this bar is under the platform floors as drawn — the top row
// is 40 tall, the actions 36 — and `hitSlop` makes up the difference rather
// than a taller bar, which would be paid for out of the list (docs/
// accessibility.md, _a 36dp box is not a 44pt target_). The two rows are 8
// apart, the action row's `py-2`, and each takes HALF of it, so neither eats
// the other's visible box. The actions also take the 8 of `py-2` under them,
// where nothing is pressable: 48 tall on a phone. No horizontal slop — they
// sit `gap-2` apart at every width (sharing the row on a phone, labelled wider
// than 44 on a wide window), so there is none to take and none needed.
const ACTION_HIT_SLOP = { top: 4, bottom: 8 } as const;

// One inline action in either shape (header): a glyph sharing the row, named by
// `aria-label`, or on a wide window a labelled button sized to its content. The
// label is then the visible text, and no `aria-label` restates it
// (docs/accessibility.md — `aria-label` only where there is no text to keep);
// the accessible name is the same words either way, which is what the e2e
// flows' `text:` selectors match.
function BarAction({
  wide,
  icon,
  iconClassName,
  label,
  className,
  ...props
}: ComponentProps<typeof Button> & {
  wide: boolean;
  icon: LucideIcon;
  iconClassName?: string;
  label: string;
}) {
  return (
    <Button
      size="sm"
      className={cn(!wide && 'flex-1', className)}
      hitSlop={ACTION_HIT_SLOP}
      aria-label={wide ? undefined : label}
      {...props}
    >
      <Icon as={icon} className={cn(wide ? 'size-4' : 'size-5', iconClassName)} />
      {wide ? <Text>{label}</Text> : null}
    </Button>
  );
}

export function BulkEditBar({ links }: { links: LinkView[] }) {
  const { selection } = useLinksPage();
  const {
    bulkEditing,
    exitBulkEdit,
    selectedLinks,
    selectAll,
    clearSelected,
    requestDestroy,
    requestRetag,
  } = useLinksViewState();
  const { updateMany } = useLinkMutations();
  const { pin, unpin } = usePinMutations();
  const wide = useWideWindow();
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  // The "Copied" flash on Copy links; the timer is cleared on unmount so a
  // pending flash can't set state on an unmounted bar.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  // Live pin membership, so Pin/Unpin split the selection correctly even as a
  // pin lands from another device mid-selection.
  const pins = useLiveRead(() => readPins(), [], ['items']);

  // Android back exits the mode before it navigates — registered only while the
  // mode is on, so back keeps its navigation meaning otherwise (and newest-first
  // ordering puts this ahead of the navigator's own handler). Inert on iOS.
  // Gated on focus for topbar.tsx's reason: this screen stays mounted under
  // Settings, and an ungated handler would take the back press meant for it.
  const focused = useIsFocused();
  useEffect(() => {
    if (!bulkEditing || !focused) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitBulkEdit();
      return true; // consumed — don't navigate
    });
    return () => sub.remove();
  }, [bulkEditing, focused, exitBulkEdit]);

  if (!bulkEditing) return null;

  const inTrash = selection.kind === 'list' && selection.id === TRASH_ID;
  const inArchive = selection.kind === 'list' && selection.id === ARCHIVE_ID;
  const count = selectedLinks.size;
  const selected = [...selectedLinks.values()];

  // Non-Trash-view targets: never touch trashed links (web's header — a view
  // can hold trashed links only via an advanced search that names Trash).
  const actionable = selected.filter((l) => l.listId !== TRASH_ID);
  const pinnedIds = new Set((pins ?? []).map((p) => p.id));
  const toPin = actionable.filter((l) => !pinnedIds.has(linkIdOf(l)));
  const toUnpin = actionable.filter((l) => pinnedIds.has(linkIdOf(l)));
  const toArchive = actionable.filter((l) => l.listId !== ARCHIVE_ID);

  // If the whole selection sits in one list (always true in a plain list view),
  // mark it checked-but-disabled in Move to; a mixed selection has no such
  // list, so nothing is marked.
  const sharedListId =
    new Set(actionable.map((l) => l.listId)).size === 1 ? actionable[0].listId : undefined;

  // The busy/exit wrapper every bulk action shares — web's bulk-edit-toolbar,
  // same shape and same reason: `run` performs the WHOLE action in one call,
  // because the list moves below are a single batched write (runMove) and a loop
  // of `update` costs a transaction, a sync kick and a full re-read + repaint of
  // the list PER LINK (useLinkMutations). Pin/unpin stay loops: `pin()` inserts
  // each link at the TOP of the pinned section, so the sequence IS the resulting
  // order (hence the reversed list at its call site).
  const runBulk = async (action: BulkAction, run: () => Promise<void>) => {
    if (busy) return;
    setBusy(action);
    try {
      await run();
      exitBulkEdit();
    } finally {
      setBusy(null);
    }
  };

  // The list moves (move, archive, unarchive, restore, remove) — one patch across
  // a selection, in one write. Links already in the target list are filtered out
  // rather than patched: a no-op `updatedAt` bump would reorder the date-modified
  // sort, and an empty batch is a no-op all the way down.
  const runMove = (action: BulkAction, targets: LinkView[], listId: string) =>
    runBulk(action, () =>
      updateMany(
        targets
          .filter((link) => link.listId !== listId)
          .map((link) => ({ link, patch: { listId } })),
      ),
    );

  const onMoveTo = (listId: string) => {
    setMoveOpen(false);
    void runMove('move', actionable, listId);
  };

  const allSelected = links.length > 0 && links.every((l) => selectedLinks.has(l.path));

  const onCopy = async () => {
    // Display order, not tap order — `links` is Main's row order.
    const urls = links.filter((l) => selectedLinks.has(l.path)).map((l) => l.url);
    try {
      await Clipboard.setStringAsync(urls.join('\n'));
    } catch {
      // Neither of web's two causes exists here — no secure-context rule, and
      // writing the clipboard needs no permission on either platform — so this
      // guards a failing native call, and stops `void onCopy()` turning it into
      // an unhandled rejection. The reason to swallow it is web's: the flash is
      // a claim that the clipboard now holds these URLs, and making it on a
      // write that failed is worse than making none, since the user's next
      // paste is what would tell them otherwise. Deliberately no error text —
      // this bar has no error surface (a failed bulk write in `runBulk` is
      // silent the same way), and its least consequential action is not where
      // to introduce one. ShowOnceSecret swallows the same way.
      return;
    }
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  const disabled = count === 0 || busy !== null;

  return (
    <View className="shrink-0 border-t border-border bg-background px-3 pt-2 pb-1">
      <View className="h-10 flex-row items-center justify-between">
        <View className="flex-row items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            testID="bulk-exit"
            aria-label="Exit bulk edit"
            onPress={exitBulkEdit}
            // 56x48 effective on the 40 box. `bottom: 4` is this row's half of
            // the gap to the actions (ACTION_HIT_SLOP); `top: 4` stays inside
            // the bar's own `pt-2`, short of the list above, whose rows are
            // pressable. The sides are free: the frame edge, and a Text.
            hitSlop={{ top: 4, bottom: 4, left: 8, right: 8 }}
          >
            <Icon as={X} className="size-5 text-foreground" />
          </Button>
          <Text testID="bulk-count" className="text-sm text-muted-foreground">
            {count} selected
          </Text>
        </View>
        <Pressable
          role="checkbox"
          aria-checked={allSelected}
          testID="bulk-select-all"
          aria-label="Select all"
          disabled={links.length === 0}
          onPress={() => (allSelected ? clearSelected() : selectAll(links))}
          // The ✕'s vertical slop, for the ✕'s reasons; `right: 12` runs out to
          // the frame edge across the bar's `px-3`. This Pressable is the
          // WHOLE target, the Checkbox inside it included — see below.
          hitSlop={{ top: 4, bottom: 4, right: 12 }}
          className="h-10 flex-row items-center gap-2 rounded-md px-1"
        >
          <Text className="text-sm text-muted-foreground">Select all</Text>
          <Checkbox
            aria-label="Select all"
            disabled={links.length === 0}
            checked={allSelected}
            onCheckedChange={() => (allSelected ? clearSelected() : selectAll(links))}
            // The kit's default 24 is switched off here: around a 16 box in a
            // 40 row it reaches 12 above and below the row — 4 past the bar's
            // `pt-2` into the list, where it would take a tap meant for the
            // last visible link, and 4 into the action under it. The Pressable
            // around it does the same thing on press and is sized to the bar.
            hitSlop={0}
          />
        </Pressable>
      </View>
      <View className={cn('flex-row items-center gap-2 py-2', wide && 'justify-end')}>
        <BarAction
          wide={wide}
          variant="outline"
          testID="bulk-copy"
          icon={copied ? Check : Copy}
          iconClassName={cn(copied && 'text-primary')}
          label={copied ? 'Copied' : 'Copy'}
          disabled={disabled}
          onPress={() => void onCopy()}
        />
        {inTrash ? (
          <>
            <BarAction
              wide={wide}
              variant="outline"
              testID="bulk-restore"
              icon={Undo2}
              label={busy === 'restore' ? 'Restoring…' : 'Restore'}
              disabled={disabled}
              onPress={() => void runMove('restore', selected, DEFAULT_LIST_ID)}
            />
            <BarAction
              wide={wide}
              variant="destructive"
              testID="bulk-delete"
              icon={Trash2}
              label="Delete permanently"
              disabled={disabled}
              onPress={() => requestDestroy(selected)}
            />
          </>
        ) : (
          <>
            <BarAction
              wide={wide}
              variant="outline"
              testID="bulk-move"
              icon={FolderInput}
              label={busy === 'move' ? 'Moving…' : 'Move to'}
              disabled={disabled || actionable.length === 0}
              onPress={() => setMoveOpen(true)}
            />
            {/* The share of the row goes on the menu ROOT, not the trigger: on
                native the root is a View of its own, so that — not the Button
                inside it — is the row's flex child, and the Button stretches
                across it. On a wide window it stays a glyph, a square among the
                labelled buttons, as web's ⋯ does. */}
            <DropdownMenu className={cn(!wide && 'flex-1')}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size={wide ? 'icon-sm' : 'sm'}
                  testID="bulk-more"
                  hitSlop={ACTION_HIT_SLOP}
                  aria-label="More actions"
                  disabled={disabled || actionable.length === 0}
                >
                  <Icon as={MoreHorizontal} className={wide ? 'size-4' : 'size-5'} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem
                  testID="bulk-menu-edit-tags"
                  onPress={() => requestRetag(actionable)}
                >
                  <Icon as={Tags} className="size-4" />
                  <Text>Edit tags</Text>
                </DropdownMenuItem>
                <DropdownMenuItem
                  testID="bulk-menu-pin"
                  disabled={toPin.length === 0}
                  // Reversed so the first-selected link ends up topmost: pin()
                  // inserts each at the top of the pinned section.
                  // Already-pinned links are skipped, so their manual order
                  // isn't churned.
                  onPress={() =>
                    void runBulk('pin', async () => {
                      for (const link of [...toPin].reverse()) await pin(link);
                    })
                  }
                >
                  <Icon as={Pin} className="size-4" />
                  <Text>Pin</Text>
                </DropdownMenuItem>
                <DropdownMenuItem
                  testID="bulk-menu-unpin"
                  disabled={toUnpin.length === 0}
                  onPress={() =>
                    void runBulk('unpin', async () => {
                      for (const link of toUnpin) await unpin(link);
                    })
                  }
                >
                  <Icon as={PinOff} className="size-4" />
                  <Text>Unpin</Text>
                </DropdownMenuItem>
                {inArchive ? (
                  <DropdownMenuItem
                    testID="bulk-menu-unarchive"
                    onPress={() => void runMove('archive', actionable, DEFAULT_LIST_ID)}
                  >
                    <Icon as={ArchiveRestore} className="size-4" />
                    <Text>Unarchive</Text>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    testID="bulk-menu-archive"
                    disabled={toArchive.length === 0}
                    onPress={() => void runMove('archive', toArchive, ARCHIVE_ID)}
                  >
                    <Icon as={Archive} className="size-4" />
                    <Text>Archive</Text>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <BarAction
              wide={wide}
              variant="destructive"
              testID="bulk-remove"
              icon={Trash2}
              label={busy === 'remove' ? 'Removing…' : 'Remove'}
              disabled={disabled || actionable.length === 0}
              onPress={() => void runMove('remove', actionable, TRASH_ID)}
            />
          </>
        )}
      </View>
      <MoveToDialog
        open={moveOpen}
        onOpenChange={setMoveOpen}
        sharedListId={sharedListId}
        onSelect={onMoveTo}
      />
    </View>
  );
}
