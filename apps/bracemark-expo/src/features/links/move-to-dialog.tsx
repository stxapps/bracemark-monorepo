// The Move-to picker — the phone stand-in for web's anchored ListCommand
// popover/submenu: the shared ListCommand body (components/links/list-command
// — the merged list tree, count-gated search) in a dialog. Shared by the bulk
// bar (its inline "Move to" button) and the row menu (its "Move to" item — web
// nests a ListCommand submenu instead; a dropdown-anchored tree doesn't fit a
// phone, the same reason the bulk bar went dialog). Trash is excluded
// (trashing is Remove, never a "move"); `sharedListId` — the selection's
// shared list, or the single link's own — shows checked and disabled via
// ListCommand's `value`/`disabledIds`, like web. The live list read is
// ListCommand's, mounted only while the dialog is open (the dialog portal
// renders null when closed), so per-item hosts never hold one live query per
// virtualized item (the useTagMap rationale).

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
  onSelect: (listId: string) => void;
}) {
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
        />
      </DialogContent>
    </Dialog>
  );
}
