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
import { type LinkView, useLinkMutations, usePinMutations } from '@stxapps/web-react';
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

// The per-row options menu — every row action lives here so each layout renders
// one `<LinkRowMenu>` and the logic stays in one place. The shape follows the
// menu convention: frequent actions first (Copy link / Edit / Move to / Edit
// tags / pin), destructive last behind a separator (Archive / Remove). The
// variant is keyed off the LINK's own `listId`, not the active view, so a
// trashed/archived link gets the right menu in the All view and tag views too:
//
//   in Trash   — Copy link / Restore / — / Delete permanently. No edit/move/pin:
//                Trash is the deletion staging area, and permanent delete is the
//                one irreversible action, so it goes through a confirmation
//                (view-state-provider `requestDestroy` → LinkDestroyConfirm).
//   in Archive — "Archive" flips to "Unarchive"; everything else as normal.
//
// Edit and Edit tags both open the page-level edit dialog (the latter landing
// focused on the tag field) via the hoisted `openEditor` — a row-owned dialog
// could be unmounted by a sync repaint mid-edit. Move to / Archive / Restore /
// Remove are all one `update({ listId })` — thin wrappers over the same op the
// dialog's Save uses. `pinned` swaps the pin block between "Pin to top" and the
// pinned set (move up/down + unpin); `isFirst`/`isLast` disable the move that
// would fall off the pinned section's ends.
//
// The menu is a sibling of the row's link, never nested inside the `<a>` — a
// button inside an anchor is invalid and would also fire the navigation. The
// wrapper stops click/keydown from bubbling so opening the menu never triggers the
// row. Dropdown content is portaled, so item clicks are outside the row entirely.
export function LinkRowMenu({
  link,
  pinned,
  isFirst,
  isLast,
}: {
  link: LinkView;
  pinned: boolean;
  isFirst: boolean;
  isLast: boolean;
}) {
  const { pin, unpin, moveUp, moveDown } = usePinMutations();
  const { update } = useLinkMutations();
  const { openEditor, requestDestroy } = useLinksViewState();
  // Open state via useEngagedOpen: reports open/close into the engagement count
  // and releases it on unmount-while-open. The menu is CONTROLLED because Move
  // to selects via a CommandItem, not a DropdownMenuItem — Radix won't
  // auto-close for it, so the select handler closes explicitly.
  const [open, handleOpenChange] = useEngagedOpen();

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
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground"
          aria-label="Link options"
        >
          <MoreHorizontal className="size-4" />
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
            {/* Only when there IS a note — this item is the way to READ one that
                the fixed-height row can only badge (NoteBadge, link-row-widgets).
                Adding a note is plain Edit, so an always-on item would just
                duplicate it. Absent in the Trash variant for the same reason
                edit/move are. */}
            {link.note && (
              <DropdownMenuItem onSelect={() => openEditor(link, 'note')}>
                <StickyNote className="size-4" />
                View note
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => openEditor(link)}>
              <Pencil className="size-4" />
              Edit
            </DropdownMenuItem>
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
                  excludeIds={[TRASH_ID]}
                  disabledIds={[link.listId]}
                  onSelect={(listId) => {
                    void update(link, { listId });
                    handleOpenChange(false);
                  }}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem onSelect={() => openEditor(link, 'tags')}>
              <Tags className="size-4" />
              Edit tags
            </DropdownMenuItem>
            {pinned ? (
              <>
                <DropdownMenuItem disabled={isFirst} onSelect={() => void moveUp(link)}>
                  <ArrowUp className="size-4" />
                  Move up
                </DropdownMenuItem>
                <DropdownMenuItem disabled={isLast} onSelect={() => void moveDown(link)}>
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
