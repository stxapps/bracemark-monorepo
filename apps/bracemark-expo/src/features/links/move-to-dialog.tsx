// The Move-to picker — the phone stand-in for web's anchored ListCommand
// popover/submenu: the shared ListCommand body (components/links/list-command
// — the merged list tree, the search field) in a dialog. Shared by the bulk
// bar (its inline "Move to" button) and the row menu (its "Move to" item — web
// nests a ListCommand submenu instead; a dropdown-anchored tree doesn't fit a
// phone, the same reason the bulk bar went dialog). Trash is excluded
// (trashing is Remove, never a "move"); `sharedListId` — the selection's
// shared list, or the single link's own — shows checked and disabled via
// ListCommand's `value`/`disabledIds`, like web.
//
// The destination can be a list that doesn't exist yet: the picker carries
// ListCommand's Create row, and confirming a name creates the list (top-level,
// index 0, like every other create) and reports it through the same `onSelect`
// a picked row does — so both hosts move into it with the code they already
// have. Web's link-move-surface.tsx carries the reasoning: leaving to make the
// list in Settings drops a bulk selection the way leaving an editor drops its
// draft.
//
// THE CREATE IS WIRED OUT HERE, NOT IN THE DIALOG'S CONTENT, and it cannot move.
// DialogContent portals into the root layout's PortalHost, which sits under
// AuthProvider but ABOVE the `(app)` layout's SyncProvider — and an
// @rn-primitives portal re-parents its children, it does not carry context the
// way a DOM portal does. `createTopLevel` comes from useListMutations, which
// reads useSync: called from inside the content it throws "useSync must be used
// within <SyncProvider>" the moment the dialog opens. Jest cannot see that with
// the package mocked at the barrel, which is why move-to-dialog.spec.tsx mounts
// the dialog under a stand-in provider with the PortalHost outside it.
// ListSelect is the same shape for the same reason: hook on the host side, a
// callback handed into the portal.
//
// That costs the host side nothing live: `createTopLevel` reads the root group
// from the store when it is called, so a mounted-but-closed dialog (the bulk bar
// keeps one for as long as the mode is on) holds no list read. The only live
// read is ListCommand's own, in the content, mounted only while the dialog is
// open.

import { useListMutations } from '@stxapps/expo-react';
import { TRASH_ID } from '@stxapps/shared';

import { ListCommand } from '../../components/links/list-command';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog';

const EXCLUDE_IDS = [TRASH_ID];

export function MoveToDialog({
  open,
  onOpenChange,
  sharedListId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sharedListId: string | undefined;
  // The destination — a picked list, or one just created from the typed name.
  onSelect: (listId: string) => void;
}) {
  const { createTopLevel } = useListMutations();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move to</DialogTitle>
        </DialogHeader>
        <ListCommand
          value={sharedListId}
          excludeIds={EXCLUDE_IDS}
          disabledIds={sharedListId !== undefined ? [sharedListId] : undefined}
          onSelect={onSelect}
          // A blank name returns null — nothing was created, so nothing to move into.
          onCreate={async (name) => {
            const list = await createTopLevel(name);
            if (list) onSelect(list.id);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
