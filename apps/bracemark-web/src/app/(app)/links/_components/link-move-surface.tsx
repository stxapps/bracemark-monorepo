'use client';

// The page-level "Move to" for links — web-ui's MoveToSurface (the shared
// picker in a dialog/sheet) plus the write it commits. Hoisted and driven by
// view-state-provider's `moving`, for the same reason as LinkDestroyConfirm and
// BulkTagsDialog: the requesting row is virtualized, so a row-owned surface
// could be unmounted by a sync repaint mid-pick.
//
// TWO CALLERS, ONE INSTANCE — and the second one is why the write lives here
// rather than in each caller:
//
//   the row menu     — one link, and only BELOW `md`. Above it the menu keeps
//                      its anchored ListCommand submenu, where hover-and-pick
//                      is the better mouse gesture; below it that submenu needs
//                      464px on a 375px screen (move-to-surface.tsx).
//   the bulk toolbar — the whole selection, at EVERY width. Its own Move-to
//                      dropdown was a third copy of this picker, and the toolbar
//                      is already a set of buttons that open page-level modals
//                      (Edit tags → BulkTagsDialog, Delete permanently →
//                      LinkDestroyConfirm), so it loses nothing by joining them.
//
// The move itself is the same one-field `update({ listId })` patch the row menu's
// Archive/Remove and the edit dialog's Save use. Links already in the target list
// are skipped, so a pick never writes a no-op patch (which would bump updatedAt
// and reorder the date-modified sort) — the same rule every bulk action follows.
// Trash is not a destination: trashing is Remove, never a "move".
//
// THE DESTINATION CAN BE A LIST THAT DOESN'T EXIST YET. The picker carries
// ListCommand's Create row, and confirming a name here creates the list AND moves
// into it — one gesture, one `busy` span. It's the editors' inline create
// (list-select.tsx) for the editors' reason: leaving to make the list in Settings
// ends bulk-edit mode and drops the selection, exactly as leaving an editor drops
// its draft. Same landing spot as every other create — top-level, index 0. Unlike
// an editor there is no Save in between, so a mistyped name is a list created and
// links filed in it; both are a move and a delete away, and the list is never left
// behind empty the way a cancelled editor leaves one.
//
// `exitBulkEdit` after a completed move matches the other two page-level
// surfaces (it's a no-op on the row-menu path, which was never in the mode).

import { useState } from 'react';

import { TRASH_ID } from '@stxapps/shared';
import { type LinkView, useLinkMutations, useListMutations } from '@stxapps/web-react';
import { MoveToSurface } from '@stxapps/web-ui/components/links/move-to-surface';

import { useLinksViewState } from '../_contexts/view-state-provider';

// Module-level so the array's identity is stable: ListCommand memoizes its
// flattened tree on `excludeIds`, and a fresh literal per render would re-walk
// the whole list tree on every keystroke in the filter box.
const EXCLUDE_IDS = [TRASH_ID];

export function LinkMoveSurface() {
  const { moving, closeMove } = useLinksViewState();
  // Unmounted while closed, so every open starts with fresh state.
  if (!moving) return null;
  return <LinkMove links={moving} onClose={closeMove} />;
}

function LinkMove({ links, onClose }: { links: LinkView[]; onClose: () => void }) {
  const { wide, exitBulkEdit } = useLinksViewState();
  const { updateMany } = useLinkMutations();
  const { createTopLevel } = useListMutations();
  const [busy, setBusy] = useState(false);

  // If every link sits in one list (always true in a plain list view, and for
  // the single-link row-menu path), show it checked-but-disabled — the tree
  // keeps its shape, and the one meaningless target is ruled out. A mixed
  // selection has no such list, so nothing is marked.
  const sharedListId =
    new Set(links.map((link) => link.listId)).size === 1 ? links[0].listId : undefined;

  // `destination` resolves the list to move into: at once for a picked row, after
  // the create for the Create row. It runs INSIDE the busy span so the two paths
  // can't interleave — a row picked while the create is still landing is refused
  // here, rather than moving the links once now and again when the create returns.
  // Null (a blank name — nothing was created) leaves the picker as it was.
  const moveTo = async (destination: () => string | null | Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    try {
      const listId = await destination();
      if (listId === null) return;
      // One batched write for the whole selection, not a loop of `update` —
      // a loop costs a transaction, a sync kick and a full re-read + repaint of
      // the list PER LINK (useLinkMutations). Links already in the target list are
      // filtered out rather than patched: an `updatedAt` bump for no change would
      // reorder the date-modified sort.
      await updateMany(
        links.filter((link) => link.listId !== listId).map((link) => ({ link, patch: { listId } })),
      );
      onClose();
      exitBulkEdit();
    } finally {
      setBusy(false);
    }
  };

  return (
    <MoveToSurface
      wide={wide}
      title="Move to"
      // Only worth a progress line when there's a batch to wait for: a single
      // link's write lands in a frame, and flashing "Moving…" for it reads as a
      // stutter rather than as feedback.
      busy={busy && links.length > 1 ? `Moving ${links.length} links…` : undefined}
      onOpenChange={(open) => !open && onClose()}
      value={sharedListId}
      excludeIds={EXCLUDE_IDS}
      disabledIds={sharedListId ? [sharedListId] : undefined}
      onSelect={(listId) => void moveTo(() => listId)}
      onCreate={(name) => moveTo(async () => (await createTopLevel(name))?.id ?? null)}
    />
  );
}
