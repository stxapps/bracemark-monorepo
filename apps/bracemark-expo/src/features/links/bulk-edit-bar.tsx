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
//  - Select all is a plain boolean checkbox — the reusables Checkbox has no
//    indeterminate (same note as the search editor's tri-state rows), so a
//    partial selection just shows unchecked; pressing it then selects all.
//  - Copy links writes through expo-clipboard (web's navigator.clipboard), with
//    the same transient flip to a check + "Copied" as the only feedback. Web
//    flips the GLYPH as well as the label because its icon-only tier renders no
//    label; this bar always renders both, so the glyph flip here is for its own
//    reason — it's the confirmation ShowOnceSecret already uses on this
//    platform (features/auth/show-once-secret.tsx), and the same button
//    shouldn't confirm two ways in one app.
//  - Move to opens a Dialog listing the list tree (the anchored ListCommand
//    popover doesn't fit a phone; no search box — the tree is small, and the
//    picker excludes Trash like web: trashing is Remove, never a "move").
//  - Android back exits the mode before it navigates (the same platform
//    cascade as the search bar's close-before-navigate).
//
// Pin/Unpin split the selection against a LIVE pin read (useLiveRead over
// readPins), so a pin landing from another device mid-selection is accounted
// for — web's useLiveQuery(readPins), verbatim in spirit.

import { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  FolderInput,
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
import { MoveToDialog } from './move-to-dialog';
import { useLinksPage } from './page-provider';
import { useLinksViewState } from './view-state-provider';

type BulkAction = 'restore' | 'move' | 'pin' | 'unpin' | 'archive' | 'remove';

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
  useEffect(() => {
    if (!bulkEditing) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      exitBulkEdit();
      return true; // consumed — don't navigate
    });
    return () => sub.remove();
  }, [bulkEditing, exitBulkEdit]);

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
          <Pressable
            role="button"
            aria-label="Exit bulk edit"
            onPress={exitBulkEdit}
            className="size-10 items-center justify-center rounded-md"
          >
            <Icon as={X} className="size-5 text-foreground" />
          </Pressable>
          <Text className="text-sm text-muted-foreground">{count} selected</Text>
        </View>
        <Pressable
          role="button"
          aria-label="Select all"
          disabled={links.length === 0}
          onPress={() => (allSelected ? clearSelected() : selectAll(links))}
          className="h-10 flex-row items-center gap-2 rounded-md px-1"
        >
          <Text className="text-sm text-muted-foreground">Select all</Text>
          <Checkbox
            aria-label="Select all"
            disabled={links.length === 0}
            checked={allSelected}
            onCheckedChange={() => (allSelected ? clearSelected() : selectAll(links))}
          />
        </Pressable>
      </View>
      <View className="flex-row items-center justify-between gap-2 py-2">
        <Button variant="outline" size="sm" disabled={disabled} onPress={() => void onCopy()}>
          <Icon as={copied ? Check : Copy} className={cn('size-4', copied && 'text-primary')} />
          <Text>{copied ? 'Copied' : 'Copy'}</Text>
        </Button>
        {inTrash ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              onPress={() => void runMove('restore', selected, DEFAULT_LIST_ID)}
            >
              <Icon as={Undo2} className="size-4" />
              <Text>{busy === 'restore' ? 'Restoring…' : 'Restore'}</Text>
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={disabled}
              onPress={() => requestDestroy(selected)}
            >
              <Icon as={Trash2} className="size-4 text-white" />
              <Text>Delete forever</Text>
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || actionable.length === 0}
              onPress={() => setMoveOpen(true)}
            >
              <Icon as={FolderInput} className="size-4" />
              <Text>{busy === 'move' ? 'Moving…' : 'Move to'}</Text>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="More actions"
                  disabled={disabled || actionable.length === 0}
                >
                  {/* 20, the one glyph in this bar that isn't 16. Three dots at
                      the vertical centre carry a fraction of the ink of the
                      Copy and Move-to glyphs beside them, so at a matching 16
                      this — the only icon here with no word to lean on — reads
                      lighter than they do. Optical, not a new size step; the
                      topbar's ⋯ (more-options-menu.tsx) is at 20 for the same
                      reason, as is web's. */}
                  <Icon as={MoreHorizontal} className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onPress={() => requestRetag(actionable)}>
                  <Icon as={Tags} className="size-4" />
                  <Text>Edit tags</Text>
                </DropdownMenuItem>
                <DropdownMenuItem
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
                    onPress={() => void runMove('archive', actionable, DEFAULT_LIST_ID)}
                  >
                    <Icon as={ArchiveRestore} className="size-4" />
                    <Text>Unarchive</Text>
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    disabled={toArchive.length === 0}
                    onPress={() => void runMove('archive', toArchive, ARCHIVE_ID)}
                  >
                    <Icon as={Archive} className="size-4" />
                    <Text>Archive</Text>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="destructive"
              size="sm"
              disabled={disabled || actionable.length === 0}
              onPress={() => void runMove('remove', actionable, TRASH_ID)}
            >
              <Icon as={Trash2} className="size-4 text-white" />
              <Text>{busy === 'remove' ? 'Removing…' : 'Remove'}</Text>
            </Button>
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
