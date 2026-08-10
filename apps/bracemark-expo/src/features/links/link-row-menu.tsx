// The per-item options menu shared by both item renderers — the expo port of
// bracemark-web's LinkRowMenu (`_layouts/shared/link-row-menu.tsx`, the canonical
// doc for the menu shape: frequent actions first, destructive last behind a
// separator; the variant keyed off the LINK's own `listId`, not the active
// view, so a trashed/archived link gets the right menu in the All view and tag
// views too — in Trash only Copy / Restore / Delete permanently, the last
// through the hoisted confirmation; in Archive "Archive" flips to "Unarchive").
// Move to / Archive / Restore / Remove are all one `update({ listId })`;
// `pinned` swaps the pin block between "Pin to top" and the pinned set (move
// up/down + unpin), with `isFirst`/`isLast` disabling the move that would fall
// off the pinned section's ends. Divergences from web:
//
//  - Copy link goes through expo-clipboard (web's navigator.clipboard).
//  - View note / Edit / Edit tags PUSH the modal edit-link route (web opens
//    the page-level hoisted dialog instead — hoisted there because virtualized
//    rows repaint under an open dialog; a pushed screen isn't row-anchored, so
//    no `editing` view state exists here). The `focus` param is web's
//    LinkEditRequest focus: 'note' scrolls to the note (the only way to READ
//    one — the fixed-height rows can only badge it), 'tags' to the tag field.
//  - Move to opens the shared MoveToDialog (a dropdown-anchored ListCommand
//    submenu doesn't fit a phone — the bulk bar's rationale). Mounted only
//    while open: the dialog holds a live list read, and this component renders
//    per virtualized item. The item press closes the menu (closeOnPress) and
//    opens the dialog in the same event, so the two engagement reports land in
//    one batch and `engaged` never observably drops between them.
//  - The menu root is uncontrolled on native (@rn-primitives' Root takes no
//    `open` prop) — useEngagedOpen just observes onOpenChange, so the
//    engagement count still holds while it's open (web's controlled-menu
//    reason, the CommandItem submenu, doesn't apply here).
//
// Nested inside the item's Pressable — fine on this platform: RN's responder
// hands the touch to the innermost pressable, so opening the menu never fires
// the item (web needed the trigger outside the row's <a> instead).

import { Pressable } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
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
} from 'lucide-react-native';

import { linkIdOf, type LinkView, useLinkMutations, usePinMutations } from '@stxapps/expo-react';
import { ARCHIVE_ID, DEFAULT_LIST_ID, TRASH_ID } from '@stxapps/shared';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { MoveToDialog } from './move-to-dialog';
import { useEngagedOpen } from './shared';
import { useLinksViewState } from './view-state-provider';

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
  const router = useRouter();
  const { pin, unpin, moveUp, moveDown } = usePinMutations();
  const { update } = useLinkMutations();
  const { requestDestroy } = useLinksViewState();
  const [, onMenuOpenChange] = useEngagedOpen();
  const [moveOpen, setMoveOpen] = useEngagedOpen();

  const inTrash = link.listId === TRASH_ID;
  const inArchive = link.listId === ARCHIVE_ID;

  const openEditor = (focus?: 'tags' | 'note') => {
    router.push({
      pathname: '/edit-link',
      params: { linkId: linkIdOf(link), ...(focus ? { focus } : {}) },
    });
  };

  const copyLink = (
    <DropdownMenuItem onPress={() => void Clipboard.setStringAsync(link.url)}>
      <Icon as={Copy} className="size-4" />
      <Text>Copy link</Text>
    </DropdownMenuItem>
  );

  return (
    <>
      <DropdownMenu onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <Pressable
            aria-label="Link options"
            className="size-8 shrink-0 items-center justify-center rounded-md"
          >
            <Icon as={MoreHorizontal} className="size-4 text-muted-foreground" />
          </Pressable>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {inTrash ? (
            <>
              {copyLink}
              <DropdownMenuItem onPress={() => void update(link, { listId: DEFAULT_LIST_ID })}>
                <Icon as={Undo2} className="size-4" />
                <Text>Restore</Text>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onPress={() => requestDestroy([link])}>
                <Icon as={Trash2} className="size-4" />
                <Text>Delete permanently</Text>
              </DropdownMenuItem>
            </>
          ) : (
            <>
              {copyLink}
              {/* Only when there IS a note — this item is the way to READ one
                  that the fixed-height row can only badge. Adding a note is
                  plain Edit, so an always-on item would just duplicate it.
                  Absent in the Trash variant for the same reason edit/move
                  are. */}
              {link.note && (
                <DropdownMenuItem onPress={() => openEditor('note')}>
                  <Icon as={StickyNote} className="size-4" />
                  <Text>View note</Text>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onPress={() => openEditor()}>
                <Icon as={Pencil} className="size-4" />
                <Text>Edit</Text>
              </DropdownMenuItem>
              <DropdownMenuItem onPress={() => setMoveOpen(true)}>
                <Icon as={FolderInput} className="size-4" />
                <Text>Move to</Text>
              </DropdownMenuItem>
              <DropdownMenuItem onPress={() => openEditor('tags')}>
                <Icon as={Tags} className="size-4" />
                <Text>Edit tags</Text>
              </DropdownMenuItem>
              {pinned ? (
                <>
                  <DropdownMenuItem disabled={isFirst} onPress={() => void moveUp(link)}>
                    <Icon as={ArrowUp} className="size-4" />
                    <Text>Move up</Text>
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={isLast} onPress={() => void moveDown(link)}>
                    <Icon as={ArrowDown} className="size-4" />
                    <Text>Move down</Text>
                  </DropdownMenuItem>
                  <DropdownMenuItem onPress={() => void unpin(link)}>
                    <Icon as={PinOff} className="size-4" />
                    <Text>Unpin</Text>
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem onPress={() => void pin(link)}>
                  <Icon as={Pin} className="size-4" />
                  <Text>Pin to top</Text>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {inArchive ? (
                <DropdownMenuItem onPress={() => void update(link, { listId: DEFAULT_LIST_ID })}>
                  <Icon as={ArchiveRestore} className="size-4" />
                  <Text>Unarchive</Text>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onPress={() => void update(link, { listId: ARCHIVE_ID })}>
                  <Icon as={Archive} className="size-4" />
                  <Text>Archive</Text>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                onPress={() => void update(link, { listId: TRASH_ID })}
              >
                <Icon as={Trash2} className="size-4" />
                <Text>Remove</Text>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* The link's own list plays `sharedListId` (checked + disabled — a single
          link's list is trivially the shared one), keeping the tree's shape and
          the user's bearings intact via ListCommand's disabledIds, like web. */}
      {moveOpen && (
        <MoveToDialog
          open
          onOpenChange={setMoveOpen}
          sharedListId={link.listId}
          onSelect={(listId) => {
            setMoveOpen(false);
            void update(link, { listId });
          }}
        />
      )}
    </>
  );
}
