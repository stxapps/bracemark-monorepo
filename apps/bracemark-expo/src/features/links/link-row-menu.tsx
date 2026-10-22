// The per-item options menu shared by both item renderers — the expo port of
// bracemark-web's LinkRowMenu (`_layouts/shared/link-row-menu.tsx`, the canonical
// doc for the menu shape: frequent actions first, destructive last behind a
// separator; the variant keyed off the LINK's own `listId`, not the active
// view, so a trashed/archived link gets the right menu in the All view and tag
// views too — in Trash only Copy / Restore / Delete permanently, the last
// through the hoisted confirmation; in Archive "Archive" flips to "Unarchive").
// Move to / Archive / Restore / Remove are all one `update({ listId })`;
// `pinned` swaps the pin block between "Pin to top" and the pinned set (move
// up/down + unpin); a move goes past `pinnedAbove`/`pinnedBelow`, the pinned
// neighbour this view renders, and is disabled where there is none. Divergences
// from web:
//
//  - Copy link goes through expo-clipboard (web's navigator.clipboard).
//  - Edit / Edit tags / Edit note PUSH the modal edit-link route (web opens
//    the page-level hoisted dialog instead — hoisted there because virtualized
//    rows repaint under an open dialog; a pushed screen isn't row-anchored, so
//    no `editing` view state exists here). The `focus` param is web's
//    LinkEditRequest focus: 'note' SCROLLS the note into view instead of
//    focusing it — reading one is still what most opens are for (the
//    fixed-height rows can only badge it), and a native focus would summon the
//    keyboard over it; 'tags' goes to the tag field.
//  - Move to opens the shared MoveToDialog (a dropdown-anchored ListCommand
//    submenu doesn't fit a phone — the bulk bar's rationale), Create row
//    included: a typed name that no list has becomes the destination. Mounted
//    only while open: the dialog holds a live list read, and this component
//    renders per virtualized item. The item press closes the menu
//    (closeOnPress) and opens the dialog in the same event, so the two
//    engagement reports land in one batch and `engaged` never observably drops
//    between them.
//  - The menu root is uncontrolled on native (@rn-primitives' Root takes no
//    `open` prop) — useEngagedOpen just observes onOpenChange, so the
//    engagement count still holds while it's open (web's controlled-menu
//    reason, the CommandItem submenu, doesn't apply here).
//
// Nested inside the item's Pressable — fine on this platform: RN's responder
// hands the touch to the innermost pressable, so opening the menu never fires
// the item (web needed the trigger outside the row's <a> instead).

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

import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { Icon } from '../../components/ui/icon';
import { Text } from '../../components/ui/text';
import { useWideWindow } from '../../lib/window-class';
import { useLinkEdit } from './link-edit-host';
import { MoveToDialog } from './move-to-dialog';
import { useEngagedOpen } from './shared';
import { useLinksViewActions } from './view-state-provider';

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
  const router = useRouter();
  const { pin, unpin, moveUp, moveDown } = usePinMutations();
  const { update } = useLinkMutations();
  const { requestDestroy } = useLinksViewActions();
  const [, onMenuOpenChange] = useEngagedOpen();
  const [moveOpen, setMoveOpen] = useEngagedOpen();

  const inTrash = link.listId === TRASH_ID;
  const inArchive = link.listId === ARCHIVE_ID;

  // The editor's shell follows the docking width: the `/edit-link` route (a
  // page sheet) below it, LinkEditHost's centred Dialog at and above it —
  // link-edit-screen.tsx's LinkEditDialog carries why an iPad cannot keep the
  // sheet.
  const wide = useWideWindow();
  const { openEdit } = useLinkEdit();
  const openEditor = (focus?: 'tags' | 'note') => {
    const linkId = linkIdOf(link);
    if (wide) {
      openEdit({ linkId, focus });
      return;
    }
    router.push({ pathname: '/edit-link', params: { linkId, ...(focus ? { focus } : {}) } });
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
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Link options"
            // The e2e handle (docs/e2e.md, _the testID contract_). Every row
            // renders one, so like the label it names A row's trigger — the
            // flows keep a single row on screen wherever they press it.
            testID="link-options"
            // 32, not the size's own 36 — the web twin pins the same box, and
            // for the same reason: growing it would push the 44pt target past
            // the gap into the row's title anchor.
            className="size-8 shrink-0"
          >
            {/* 20, not 16 — three dots at the vertical centre carry a fraction of
                a solid glyph's ink, so at a matching 16 they read smaller. The
                optical correction web's topbar documents, applied to every ⋯ in
                both apps; the BOX is unchanged. */}
            <Icon as={MoreHorizontal} className="size-5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        {/* `link-menu-*` ids: the menu is a portal over the list, and a label
            match under an open overlay can resolve to the view beneath it —
            "Archive" is also a drawer row and, once there, the topbar's title
            (docs/app-drivers.md, _a text match can resolve to a node under the
            drawer_). */}
        <DropdownMenuContent align="end" className="w-52">
          {inTrash ? (
            <>
              {copyLink}
              <DropdownMenuItem
                testID="link-menu-restore"
                onPress={() => void update(link, { listId: DEFAULT_LIST_ID })}
              >
                <Icon as={Undo2} className="size-4" />
                <Text>Restore</Text>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                testID="link-menu-delete"
                onPress={() => requestDestroy([link])}
              >
                <Icon as={Trash2} className="size-4" />
                <Text>Delete permanently</Text>
              </DropdownMenuItem>
            </>
          ) : (
            <>
              {copyLink}
              <DropdownMenuItem testID="link-menu-edit" onPress={() => openEditor()}>
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
              {/* Pairs with Edit tags: both are field-focused shortcuts into
                  the screen Edit pushes. Always on, like its sibling — a
                  note-only condition would make the menu two shapes, and this
                  is also the READ path, since the fixed-height row can only
                  badge a note and the field has no read-only surface. Absent in
                  the Trash variant, like the other edits. */}
              <DropdownMenuItem onPress={() => openEditor('note')}>
                <Icon as={StickyNote} className="size-4" />
                <Text>Edit note</Text>
              </DropdownMenuItem>
              {pinned ? (
                <>
                  <DropdownMenuItem
                    disabled={!pinnedAbove}
                    onPress={() => pinnedAbove && void moveUp(link, pinnedAbove)}
                  >
                    <Icon as={ArrowUp} className="size-4" />
                    <Text>Move up</Text>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={!pinnedBelow}
                    onPress={() => pinnedBelow && void moveDown(link, pinnedBelow)}
                  >
                    <Icon as={ArrowDown} className="size-4" />
                    <Text>Move down</Text>
                  </DropdownMenuItem>
                  <DropdownMenuItem testID="link-menu-unpin" onPress={() => void unpin(link)}>
                    <Icon as={PinOff} className="size-4" />
                    <Text>Unpin</Text>
                  </DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem testID="link-menu-pin" onPress={() => void pin(link)}>
                  <Icon as={Pin} className="size-4" />
                  <Text>Pin to top</Text>
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {inArchive ? (
                <DropdownMenuItem
                  testID="link-menu-unarchive"
                  onPress={() => void update(link, { listId: DEFAULT_LIST_ID })}
                >
                  <Icon as={ArchiveRestore} className="size-4" />
                  <Text>Unarchive</Text>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  testID="link-menu-archive"
                  onPress={() => void update(link, { listId: ARCHIVE_ID })}
                >
                  <Icon as={Archive} className="size-4" />
                  <Text>Archive</Text>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                variant="destructive"
                testID="link-menu-remove"
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
