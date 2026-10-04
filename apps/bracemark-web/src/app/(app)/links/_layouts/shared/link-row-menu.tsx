'use client';

import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Copy,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  StickyNote,
  Tags,
  Trash2,
  Undo2,
} from 'lucide-react';

import { ARCHIVE_ID, DEFAULT_LIST_ID, TRASH_ID } from '@stxapps/shared';
import {
  type LinkView,
  useLinkMutations,
  useListMutations,
  usePinMutations,
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

import { useLinksViewState } from '../../_contexts/view-state-provider';
import { useEngagedOpen } from './hooks';

// Module-level so the array's identity is stable: ListCommand memoizes its
// flattened tree on `excludeIds`, and a fresh literal per render would re-walk
// the whole list tree on every keystroke in the filter box.
const EXCLUDE_IDS = [TRASH_ID];

// The per-row options menu — every row action lives here so each layout renders
// one `<LinkRowMenu>` and the logic stays in one place. The shape follows the
// menu convention: frequent actions first (Copy link / Edit / Move to / Edit
// tags / Edit note / pin), destructive last behind a separator (Archive /
// Remove). The
// variant is keyed off the LINK's own `listId`, not the active view, so a
// trashed/archived link gets the right menu in the All view and tag views too:
//
//   in Trash   — Copy link / Restore / — / Delete permanently. No edit/move/pin:
//                Trash is the deletion staging area, and permanent delete is the
//                one irreversible action, so it goes through a confirmation
//                (view-state-provider `requestDestroy` → LinkDestroyConfirm).
//   in Archive — "Archive" flips to "Unarchive"; everything else as normal.
//
// Edit, Edit tags and Edit note all open the page-level edit dialog (the latter
// two landing focused on that field) via the hoisted `openEditor` — a row-owned
// dialog could be unmounted by a sync repaint mid-edit. Move to / Archive / Restore /
// Remove are all one `update({ listId })` — thin wrappers over the same op the
// dialog's Save uses.
//
// MOVE TO HAS TWO SHAPES, split at `md` (view-state-provider's `wide`, one
// matchMedia for the page rather than one per virtualized row). Above it, the
// ListCommand submenu below: hover-and-pick, in place, no modal. Below it, an
// item that hands the link to the page-level LinkMoveSurface — because the
// submenu wants 464px beside a 192px parent menu, which a 375px phone doesn't
// have, and because the picker's filter box summons a keyboard the floating
// layer can't measure (the arithmetic and the rest of the reasoning are in
// move-to-surface.tsx). The narrow item is the ONLY one here that doesn't act
// immediately, hence the ellipsis. Both shapes carry the picker's Create row:
// typing a name that no list has creates it and moves the link there
// (link-move-surface.tsx carries the reasoning). `pinned` swaps the pin block between "Pin to top" and the
// pinned set (move up/down + unpin); a move goes past `pinnedAbove`/
// `pinnedBelow`, the pinned neighbour this view renders — pins are one global
// order filtered per view, so the neighbour, not an index, names the slot — and
// is disabled where there is none.
//
// The menu is a sibling of the row's link, never nested inside the `<a>` — a
// button inside an anchor is invalid and would also fire the navigation. The
// wrapper stops click/keydown from bubbling so opening the menu never triggers the
// row. Dropdown content is portaled, so item clicks are outside the row entirely.
export function LinkRowMenu({
  link,
  pinned,
  pinnedAbove,
  pinnedBelow,
}: {
  link: LinkView;
  pinned: boolean;
  pinnedAbove: LinkView | undefined;
  pinnedBelow: LinkView | undefined;
}) {
  const { pin, unpin, moveUp, moveDown } = usePinMutations();
  const { update } = useLinkMutations();
  // Bound on the row, like the two above: `createTopLevel` reads the store when
  // it is called and holds no live list read. The picker's own live read is
  // ListCommand's, inside the submenu's content, which exists only while open.
  const { createTopLevel } = useListMutations();
  const { openEditor, requestDestroy, requestMove, wide } = useLinksViewState();
  // Open state via useEngagedOpen: reports open/close into the engagement count
  // and releases it on unmount-while-open. The menu is CONTROLLED because Move
  // to selects via a CommandItem, not a DropdownMenuItem — Radix won't
  // auto-close for it, so the select handler closes explicitly.
  const [open, handleOpenChange] = useEngagedOpen();

  // The wide submenu's move — a picked list, or one just created from the typed
  // name — closing the menu itself, since a CommandItem pick closes nothing.
  const moveTo = (listId: string) => {
    void update(link, { listId });
    handleOpenChange(false);
  };

  const inTrash = link.listId === TRASH_ID;
  const inArchive = link.listId === ARCHIVE_ID;

  const copyLink = (
    <DropdownMenuItem onSelect={() => void navigator.clipboard.writeText(link.url)}>
      <Copy className="size-4" />
      Copy link
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        {/* 32px box, 44px target. The `after:` pseudo-element is an invisible hit
            expansion (-6px on every edge), the same trick Checkbox and RadioGroupItem
            use — it needs the `relative` beside it, since Button's base has none.
            Deleting it looks like removing a rule that draws nothing: the button
            still works, and nothing lints or fails. It matters most on a narrow
            pane, where the sorted-date column is hidden (@xl) and the trigger's
            left neighbour is the row's title ANCHOR across a 12px gap — a thumb
            that overshoots navigates off to an external site. 44 reaches 6px into
            that gap, so the target grows without ever overlapping the anchor. */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative shrink-0 text-muted-foreground after:absolute after:-inset-1.5"
          aria-label="Link options"
        >
          {/* 20, not 16 — the same optical correction the topbar's overflow
              trigger documents (more-options-menu.tsx): three dots at the
              vertical centre carry a fraction of a solid glyph's ink, so at a
              matching 16 they read smaller. The BOX stays 32: the bulk-edit
              toolbar already renders this 20-in-32, and growing the box would
              push the 44px target above past the 12px gap into the row's
              title anchor. */}
          <MoreHorizontal className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {inTrash ? (
          <>
            {copyLink}
            <DropdownMenuItem onSelect={() => void update(link, { listId: DEFAULT_LIST_ID })}>
              <Undo2 className="size-4" />
              Restore
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => requestDestroy([link])}>
              <Trash2 className="size-4" />
              Delete permanently
            </DropdownMenuItem>
          </>
        ) : (
          <>
            {copyLink}
            <DropdownMenuItem onSelect={() => openEditor(link)}>
              <Pencil className="size-4" />
              Edit
            </DropdownMenuItem>
            {wide ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderInput className="size-4" />
                  Move to
                </DropdownMenuSubTrigger>
                {/* The same searchable list command as ListSelect (list-command.tsx).
                    No Trash target — trashing is Remove, never a "move". The link's
                    current list stays visible but disabled (and checked), keeping the
                    tree's shape (and the user's bearings) intact. Locked/hidden lists
                    stay pickable: hiding only declutters the sidebar, it never blocks
                    filing a link into a list you know exists. */}
                <DropdownMenuSubContent className="w-64 p-0">
                  <ListCommand
                    value={link.listId}
                    excludeIds={EXCLUDE_IDS}
                    disabledIds={[link.listId]}
                    onSelect={moveTo}
                    onCreate={async (name) => {
                      const list = await createTopLevel(name);
                      if (list) moveTo(list.id);
                    }}
                  />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : (
              /* Same picker, same exclusions — LinkMoveSurface passes them, since
                 it serves the bulk toolbar too. A plain Item, so Radix closes the
                 menu for us (the submenu above is why this menu is controlled at
                 all: a CommandItem pick isn't a menu selection). */
              <DropdownMenuItem onSelect={() => requestMove([link])}>
                <FolderInput className="size-4" />
                Move to…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => openEditor(link, 'tags')}>
              <Tags className="size-4" />
              Edit tags
            </DropdownMenuItem>
            {/* Pairs with Edit tags: both are field-focused shortcuts into the
                dialog Edit opens. Always on, like its sibling — a note-only
                condition would make the menu two shapes, and this is also the
                READ path, since the fixed-height row can only badge a note
                (NoteBadge, link-row-widgets) and the field has no read-only
                surface. Absent in the Trash variant, like the other edits. */}
            <DropdownMenuItem onSelect={() => openEditor(link, 'note')}>
              <StickyNote className="size-4" />
              Edit note
            </DropdownMenuItem>
            {pinned ? (
              <>
                <DropdownMenuItem
                  disabled={!pinnedAbove}
                  onSelect={() => pinnedAbove && void moveUp(link, pinnedAbove)}
                >
                  <ArrowUp className="size-4" />
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!pinnedBelow}
                  onSelect={() => pinnedBelow && void moveDown(link, pinnedBelow)}
                >
                  <ArrowDown className="size-4" />
                  Move down
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void unpin(link)}>
                  <PinOff className="size-4" />
                  Unpin
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem onSelect={() => void pin(link)}>
                <Pin className="size-4" />
                Pin to top
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {inArchive ? (
              <DropdownMenuItem onSelect={() => void update(link, { listId: DEFAULT_LIST_ID })}>
                <ArchiveRestore className="size-4" />
                Unarchive
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => void update(link, { listId: ARCHIVE_ID })}>
                <Archive className="size-4" />
                Archive
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => void update(link, { listId: TRASH_ID })}
            >
              <Trash2 className="size-4" />
              Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
