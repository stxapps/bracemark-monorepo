'use client';

// The confirmation behind Trash's "Delete permanently" — the one irreversible
// link action (destroy removes the link plus its pin/extraction/`files/` content
// on every device), so it never fires straight off a click. Hoisted to the page
// level and driven by view-state-provider's `destroying`, for the same reason as
// LinkEditDialog: the requesting row is virtualized, so a row-owned dialog could
// be unmounted by a repaint mid-confirmation. Two callers, one dialog: the row
// menu confirms a single link (named in the message), the bulk-edit toolbar
// confirms the whole selection (counted in the message; the destroy also ends
// bulk-edit mode — exitBulkEdit is a no-op for the row-menu path).

import { useState } from 'react';

import { hostFromText } from '@stxapps/shared';
import { useLinkMutations } from '@stxapps/web-react';
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

import { useLinksViewState } from '../_contexts/view-state-provider';

export function LinkDestroyConfirm() {
  const { destroying, closeDestroy, exitBulkEdit } = useLinksViewState();
  const { destroy } = useLinkMutations();
  const [deleting, setDeleting] = useState(false);

  if (!destroying) return null;

  const onConfirm = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      for (const link of destroying) {
        await destroy(link);
      }
      closeDestroy();
      exitBulkEdit();
    } finally {
      setDeleting(false);
    }
  };

  // requestDestroy ignores empty requests, so `destroying` has at least one.
  const what =
    destroying.length === 1
      ? `“${destroying[0].title || hostFromText(destroying[0].url)}” and its saved content`
      : `${destroying.length} links and their saved content`;

  return (
    <AlertDialog open onOpenChange={(open) => !open && closeDestroy()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
          <AlertDialogDescription>
            {what} will be removed from all your devices. This can&rsquo;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={deleting}
            onClick={(e) => {
              // Keep the dialog up (and its state authoritative) until destroy
              // resolves — the default Action click would close it immediately.
              e.preventDefault();
              void onConfirm();
            }}
          >
            {deleting ? 'Deleting…' : 'Delete permanently'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
