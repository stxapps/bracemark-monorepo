'use client';

// The toolbar shown while bulk-edit mode is on (view-state-provider
// `bulkEditing`): an exit (✕) affordance + Select all + the selected count on
// the left, the actions on the right — the dismiss control anchors the left
// edge, away from the destructive actions (Remove / Delete permanently) that
// end the right cluster. It acts on the hoisted `selectedLinks` snapshot map; the one thing
// it takes from outside is `links` — the rows the active layout is showing
// (Main passes the same useLinks result it hands the layout) — which feeds
// Select all and puts the copied URLs in display order. The action set mirrors
// the row menu (LinkRowMenu) over the whole selection:
//
//   Select all — every loaded row (the growing-limit page useLinks currently
//               holds — bulk-edit mode holds `engaged`, so sync can't grow or
//               reorder it underneath; "Show more" can, dropping the checkbox
//               to indeterminate). Unchecking clears the selection without
//               leaving the mode.
//   Copy links — both views (it's the row menu's Copy link over the selection):
//               the selected URLs, newline-separated, in display order. Reads
//               only, so trashed links are included, it does NOT exit the mode
//               (see below), and the button flips to a check + "Copied" for a
//               beat as the only feedback a clipboard write gets.
//
// The rest follows the same view split as the row menu:
//
//   in Trash  — "Restore" (back to My List — the same `update({ listId })` the
//               row menu's Restore is) and "Delete permanently", the one
//               irreversible action, so it goes through the confirmation
//               (requestDestroy → LinkDestroyConfirm, which exits bulk-edit
//               mode after the destroy).
//   elsewhere — "Move to" (requestMove → LinkMoveSurface, the shared picker —
//               no Trash target, trashing is Remove, never a "move"),
//               "Edit tags" (requestRetag → BulkTagsDialog), Pin/Unpin, then
//               the destructive pair: "Archive" (flipping to "Unarchive" in the
//               Archive view, like the row menu) and "Remove" (a reversible
//               move to Trash, so no confirmation).
//
// Keyed off the ACTIVE VIEW (the page selection), not each link's own listId —
// the toolbar is one button for the whole selection, and navigation exits
// bulk-edit mode (view-state-provider), so the selection always belongs to the
// view whose semantics the buttons show. One wrinkle the row menu doesn't have:
// a view can hold TRASHED links whose own row menu allows only Restore/destroy —
// so every non-Trash-view action here filters trashed links out of its targets
// (`actionable`), keeping the row menu's per-link semantics without forking the
// toolbar per link. Browsing can't produce that mix any more (use-links suppresses
// Trash outside the Trash view), but an advanced search that names Trash ALONGSIDE
// another list opts back in and resolves to no single-axis selection — so it lands
// here with the non-Trash buttons over a mixed selection. Each action also drops links
// already in its target state, so it never writes a no-op patch (which would
// bump updatedAt and reorder the date-modified sort).
//
// The button set is fixed per view and a button DISABLES when its target set is
// empty (rather than appearing/disappearing), so the toolbar doesn't reflow
// under the user mid-multi-select. What DOES vary is how much of each action is
// SHOWN, in two tiers keyed off the pane's own width — never off the selection,
// so neither can shift mid-multi-select:
//
//   < COLLAPSE_WIDTH  — the secondary actions (Edit tags, Pin, Unpin, Archive,
//                       Delete copies) collapse into a ⋯ overflow menu, leaving
//                       Copy, Move to and the destructive Remove inline.
//   < ICON_WIDTH      — those three shed their labels and become square icon
//                       buttons (name kept in `aria-label`/`title`, so nothing
//                       is lost to a screen reader or a hover). This is what
//                       gets the fixed set onto a phone: at 390px the labelled
//                       row is half again too wide, and the alternative — hiding
//                       Remove behind the same ⋯ as Archive — would put the one
//                       irreversible-looking action in a menu the user opens by
//                       reflex.
//
// One bulk action runs at a time (`busy`), and every completed WRITE exits
// bulk-edit mode — the selection has been consumed, and after a Move/Archive/
// Remove the rows it named have left the view. Copy is the deliberate exception:
// it changes nothing, so the selection still describes exactly the rows on
// screen, and it's the one action worth chaining (copy the URLs, then file
// them). It's also the one action with no visible result of its own — a
// clipboard write is invisible, so a toolbar that vanished would read as "did
// that copy, or did I hit ✕?" rather than as confirmation. The three that open
// a page-level modal instead of writing straight away — Move to, Edit tags,
// Delete permanently — hand the selection to view-state-provider and let that
// surface do both (it also exits the mode), so they carry no `busy` state here.
// Delete copies confirms in place instead (its own AlertDialog below): it removes
// the selection's kept copies — read mode and screenshot — on every device, which
// can't be undone, and it is a write like Archive, so it carries `busy` and exits
// the mode when done (docs/link-extraction-keep.md, _removal, cleanup, export_).
// Move to used to be a `w-64` dropdown holding its own ListCommand, i.e. a
// third copy of a picker the row menu and the Lists settings already embed; it
// became a request for the same reason its two neighbours are ones.

import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  Archive,
  ArchiveRestore,
  BookX,
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
} from 'lucide-react';

import { ARCHIVE_ID, DEFAULT_LIST_ID, TRASH_ID } from '@stxapps/shared';
import {
  linkIdOf,
  type LinkView,
  readPins,
  useKeptCopyMutations,
  useLinkMutations,
  usePinMutations,
} from '@stxapps/web-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@stxapps/web-ui/components/ui/alert-dialog';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { Checkbox } from '@stxapps/web-ui/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@stxapps/web-ui/components/ui/dropdown-menu';
import { useElementWidth } from '@stxapps/web-ui/hooks/use-element-size';
import { cn } from '@stxapps/web-ui/lib/utils';

import { useLinksPage } from '../_contexts/page-provider';
import { useLinksViewState } from '../_contexts/view-state-provider';

type BulkAction = 'restore' | 'pin' | 'unpin' | 'archive' | 'copies' | 'remove';

// Below this container width the secondary actions (Edit tags, Pin, Unpin,
// Archive, Delete copies) collapse into a ⋯ overflow menu so the fixed button row never spills
// off a narrow pane (the collapsible sidebar can widen the sidebar / shrink this
// pane without a window resize, and the extension popup is narrower still).
// Copy, Move to, and the destructive Remove stay inline at every width. Measured
// via `useElementWidth` (not a CSS container query) so each action is declared
// once and rendered as either a Button or a menu item — no duplicated markup.
// Tuned to roughly where the widest inline set (the normal non-Trash view, eight
// right-hand buttons) stops fitting — 900 for seven, plus ~150 for Delete copies
// (icon, a 13-character label, padding and the gap; estimated from the button's
// metrics, not measured in a browser — re-measure if the row spills); below the return we keep the full set inline
// until the first measurement lands (width 0), matching card-layout's approach.
const COLLAPSE_WIDTH = 1050;
// Below this the three surviving inline buttons drop their labels (see the
// header). Tuned to where the widest labelled trio — Copy links / Move to /
// Remove plus the ⋯ — stops fitting beside the left cluster's count.
const ICON_WIDTH = 560;

// One secondary action, renderable as an inline Button or an overflow menu item.
type SecondaryAction = {
  key: string;
  icon: ReactNode;
  label: string;
  disabled: boolean;
  run: () => void;
};

// An inline toolbar action, in whichever of the two tiers is in force. Icon-only
// is a real square button (`icon-sm`), not a padded one with hidden text — the
// row is 3rem tall and the extra 8px per button is the difference between four
// actions fitting a 320px pane and not. Props spread LAST so a caller can
// override the variant (Remove is destructive) and so Radix's `asChild` triggers
// can pass their wiring straight through.
function ActionButton({
  icon,
  label,
  iconOnly,
  ...props
}: ComponentProps<typeof Button> & { icon: ReactNode; label: string; iconOnly: boolean }) {
  return (
    <Button
      variant="outline"
      size={iconOnly ? 'icon-sm' : 'sm'}
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      {...props}
    >
      {icon}
      {iconOnly ? null : label}
    </Button>
  );
}

export function BulkEditToolbar({ links }: { links: LinkView[] }) {
  const { selection } = useLinksPage();
  const {
    bulkEditing,
    exitBulkEdit,
    selectedLinks,
    selectAll,
    clearSelected,
    requestDestroy,
    requestRetag,
    requestMove,
  } = useLinksViewState();
  const { updateMany } = useLinkMutations();
  const { pin, unpin } = usePinMutations();
  const { removeAllCopies } = useKeptCopyMutations();
  const [busy, setBusy] = useState<BulkAction | null>(null);
  const [confirmingCopies, setConfirmingCopies] = useState(false);
  // The "Copied" flash on Copy links; the timer is cleared on unmount so a
  // pending flash can't set state on an unmounted toolbar.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  // Track the toolbar's own width so the secondary actions collapse into a ⋯
  // menu on a narrow pane (see COLLAPSE_WIDTH). The root is held as STATE (via a
  // callback ref) rather than a RefObject so useElementWidth re-measures when the
  // toolbar mounts on entering bulk-edit — a RefObject would leave width at 0.
  const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(rootEl);

  // Live pin membership, so Pin/Unpin split the selection correctly even as a
  // pin lands from another device mid-selection.
  const pins = useLiveQuery(() => readPins(), []);

  if (!bulkEditing) return null;

  const inTrash = selection.kind === 'list' && selection.id === TRASH_ID;
  const inArchive = selection.kind === 'list' && selection.id === ARCHIVE_ID;
  const count = selectedLinks.size;
  const selected = [...selectedLinks.values()];

  // Non-Trash-view targets: never touch trashed links (see the header).
  const actionable = selected.filter((l) => l.listId !== TRASH_ID);
  const pinnedIds = new Set((pins ?? []).map((p) => p.id));
  const toPin = actionable.filter((l) => !pinnedIds.has(linkIdOf(l)));
  const toUnpin = actionable.filter((l) => pinnedIds.has(linkIdOf(l)));
  const toArchive = actionable.filter((l) => l.listId !== ARCHIVE_ID);
  // Every selected link with a kept copy — Trash included: a copy is the user's to
  // delete wherever its link sits.
  const withCopies = selected.filter((l) => l.readModeId || l.screenshotId);

  // The busy/exit wrapper every bulk action shares. `run` performs the WHOLE
  // action in one call rather than being applied per link, because the list moves
  // below are a single batched write (runMove) — a loop of `update` costs a
  // transaction, a sync kick and a full re-read + repaint of the list PER LINK
  // (useLinkMutations). Pin/unpin stay loops: `pin()` inserts each link at the TOP
  // of the pinned section, so the sequence IS the resulting order, and there is no
  // batched spelling of that (hence the reversed list at its call site).
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

  // The four list moves (archive, unarchive, restore, remove) — one patch across
  // a selection, in one write. Links already in the target list are filtered out
  // rather than patched: an `updatedAt` bump for no change would reorder the
  // date-modified sort, and an empty batch is a no-op all the way down.
  const runMove = (action: BulkAction, links: LinkView[], listId: string) =>
    runBulk(action, () =>
      updateMany(
        links.filter((link) => link.listId !== listId).map((link) => ({ link, patch: { listId } })),
      ),
    );

  const allSelected = links.length > 0 && links.every((l) => selectedLinks.has(l.path));

  const onCopy = async () => {
    // Display order, not click order — `links` is the layout's row order.
    const urls = links.filter((l) => selectedLinks.has(l.path)).map((l) => l.url);
    try {
      await navigator.clipboard.writeText(urls.join('\n'));
    } catch {
      // Clipboard blocked (insecure context / denied permission) — both
      // page-wide conditions, not something about this selection. Leave the
      // button unflipped and say nothing: the flash is a claim that the
      // clipboard now holds these URLs, and showing it on a write that failed
      // is worse than showing nothing, since the user's next paste is what
      // would tell them otherwise. Deliberately no error text — this toolbar
      // has no error surface (a failed bulk write in `runBulk` is silent the
      // same way), and one row 3rem tall is not where to introduce the app's
      // only self-announcing one for its least consequential action.
      return;
    }
    setCopied(true);
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  const disabled = count === 0 || busy !== null;

  // Keep the full set inline, labelled, until the first measurement (width 0)
  // so a wide pane doesn't flash the ⋯ menu — or a row of bare icons — on mount.
  const collapsed = width > 0 && width < COLLAPSE_WIDTH;
  const iconOnly = width > 0 && width < ICON_WIDTH;

  // The collapsible middle of the non-Trash action set, declared once. Archive
  // flips to Unarchive (and its target set) inside the Archive view, matching the
  // inline pair the row menu shows.
  const secondaryActions: SecondaryAction[] = [
    {
      key: 'tags',
      icon: <Tags data-icon="inline-start" className="size-4" />,
      label: 'Edit tags',
      disabled: disabled || actionable.length === 0,
      run: () => requestRetag(actionable),
    },
    {
      key: 'pin',
      icon: <Pin data-icon="inline-start" className="size-4" />,
      label: busy === 'pin' ? 'Pinning…' : 'Pin',
      disabled: disabled || toPin.length === 0,
      // Reversed so the first-selected link ends up topmost: pin() inserts each
      // at the top of the pinned section. Already-pinned links are skipped, so
      // their manual order isn't churned.
      run: () =>
        void runBulk('pin', async () => {
          for (const link of [...toPin].reverse()) await pin(link);
        }),
    },
    {
      key: 'unpin',
      icon: <PinOff data-icon="inline-start" className="size-4" />,
      label: busy === 'unpin' ? 'Unpinning…' : 'Unpin',
      disabled: disabled || toUnpin.length === 0,
      run: () =>
        void runBulk('unpin', async () => {
          for (const link of toUnpin) await unpin(link);
        }),
    },
    inArchive
      ? {
          key: 'archive',
          icon: <ArchiveRestore data-icon="inline-start" className="size-4" />,
          label: busy === 'archive' ? 'Unarchiving…' : 'Unarchive',
          disabled,
          run: () => void runMove('archive', actionable, DEFAULT_LIST_ID),
        }
      : {
          key: 'archive',
          icon: <Archive data-icon="inline-start" className="size-4" />,
          label: busy === 'archive' ? 'Archiving…' : 'Archive',
          disabled: disabled || toArchive.length === 0,
          run: () => void runMove('archive', toArchive, ARCHIVE_ID),
        },
    {
      key: 'copies',
      icon: <BookX data-icon="inline-start" className="size-4" />,
      label: busy === 'copies' ? 'Deleting…' : 'Delete copies',
      disabled: disabled || withCopies.length === 0,
      run: () => setConfirmingCopies(true),
    },
  ];

  return (
    <div
      ref={setRootEl}
      className={cn(
        'flex h-12 shrink-0 items-center justify-between border-b border-border bg-muted/30',
        iconOnly ? 'gap-2 px-3' : 'gap-3 px-4',
      )}
    >
      <div className={cn('flex items-center', iconOnly ? 'gap-2' : 'gap-3')}>
        <Button variant="ghost" size="icon-sm" aria-label="Exit bulk edit" onClick={exitBulkEdit}>
          <X className="size-4" />
        </Button>
        <Checkbox
          aria-label="Select all"
          disabled={links.length === 0}
          checked={allSelected ? true : count > 0 ? 'indeterminate' : false}
          onCheckedChange={() => (allSelected ? clearSelected() : selectAll(links))}
        />
        {/* The count stays a WORD at every width: it's the only readout of what
            the buttons beside it are about to act on, and a bare numeral next to
            a checkbox reads as a badge, not a total. */}
        <span className="text-sm whitespace-nowrap text-muted-foreground">{count} selected</span>
      </div>
      <div className="flex items-center gap-2">
        {/* The GLYPH flips too, not just the label: below ICON_WIDTH the label
            isn't rendered, so a label-only flash would leave the one action
            whose result is invisible with no feedback at all on exactly the
            width where it's hardest to tell anything happened. Check +
            `text-primary` is the same confirmation ShowOnceSecret uses. The
            accessible name and the tooltip flip with `label` already
            (ActionButton feeds both from it when icon-only), and the change is
            user-initiated on a focused control, so it needs no live region —
            see accessibility.md, "who caused the change". */}
        <ActionButton
          icon={
            copied ? (
              <Check data-icon="inline-start" className="size-4 text-primary" />
            ) : (
              <Copy data-icon="inline-start" className="size-4" />
            )
          }
          label={copied ? 'Copied' : count === 1 ? 'Copy link' : 'Copy links'}
          iconOnly={iconOnly}
          disabled={disabled}
          onClick={() => void onCopy()}
        />
        {inTrash ? (
          <>
            <ActionButton
              icon={<Undo2 data-icon="inline-start" className="size-4" />}
              label={busy === 'restore' ? 'Restoring…' : 'Restore'}
              iconOnly={iconOnly}
              disabled={disabled}
              onClick={() => void runMove('restore', selected, DEFAULT_LIST_ID)}
            />
            <ActionButton
              variant="destructive"
              icon={<Trash2 data-icon="inline-start" className="size-4" />}
              label="Delete permanently"
              iconOnly={iconOnly}
              disabled={disabled}
              onClick={() => requestDestroy(selected)}
            />
          </>
        ) : (
          <>
            <ActionButton
              icon={<FolderInput data-icon="inline-start" className="size-4" />}
              label="Move to"
              iconOnly={iconOnly}
              disabled={disabled || actionable.length === 0}
              onClick={() => requestMove(actionable)}
            />
            {collapsed ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size={iconOnly ? 'icon-sm' : 'sm'}
                    aria-label="More actions"
                    title="More actions"
                    disabled={disabled || actionable.length === 0}
                  >
                    {/* 20, matching the topbar's overflow trigger — same glyph,
                        same optical correction (more-options-menu.tsx). */}
                    <MoreHorizontal className="size-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  {secondaryActions.map((action) => (
                    <DropdownMenuItem
                      key={action.key}
                      disabled={action.disabled}
                      onSelect={action.run}
                    >
                      {action.icon}
                      {action.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              secondaryActions.map((action) => (
                <ActionButton
                  key={action.key}
                  icon={action.icon}
                  label={action.label}
                  // Unreachable in practice (every width below COLLAPSE_WIDTH is
                  // also below ICON_WIDTH, so this branch only runs on a wide
                  // pane), but passed rather than hardcoded false so the two
                  // tiers stay independent if either number moves.
                  iconOnly={iconOnly}
                  disabled={action.disabled}
                  onClick={action.run}
                />
              ))
            )}
            <ActionButton
              variant="destructive"
              icon={<Trash2 data-icon="inline-start" className="size-4" />}
              label={busy === 'remove' ? 'Removing…' : 'Remove'}
              iconOnly={iconOnly}
              disabled={disabled || actionable.length === 0}
              onClick={() => void runMove('remove', actionable, TRASH_ID)}
            />
          </>
        )}
      </div>
      <AlertDialog open={confirmingCopies} onOpenChange={setConfirmingCopies}>
        <AlertDialogContent>
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle>
              Delete the kept copies of {withCopies.length} link
              {withCopies.length === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription className="text-pretty">
              Their read-mode copies and screenshots are removed from all your devices. The links
              stay. A new copy can only be taken from the page itself, if it still shows the same
              thing.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() =>
                void runBulk('copies', async () => {
                  await removeAllCopies(withCopies);
                })
              }
            >
              Delete copies
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
