// The confirmation behind Trash's "Delete forever" — the expo port of
// bracemark-web's LinkDestroyConfirm (`(app)/links/_components/
// link-destroy-confirm.tsx`, the canonical doc: destroy is the one
// irreversible link action — it removes the link plus its pin/extraction/
// `files/` content on every device — so it never fires straight off a tap).
// Hoisted to the screen level and driven by view-state-provider's `destroying`
// for the same reason: the requesting row is virtualized, so a row-owned
// dialog could be unmounted by a repaint mid-confirmation. Callers today: the
// bulk-edit bar confirms the whole selection (the destroy also ends bulk-edit
// mode); the row menu joins with a single-element list when it's ported.
//
// One mechanical divergence: the confirm action is a plain destructive Button,
// not AlertDialogAction — the rn-primitives Action closes the root BEFORE the
// press handler runs (no preventDefault like Radix), and the dialog must stay
// up (its state authoritative) until the destroy resolves.

import { useState } from 'react';

import { useLinkMutations } from '@stxapps/expo-react';
import { hostFromText } from '@stxapps/shared';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog';
import { Button } from '../../components/ui/button';
import { Text } from '../../components/ui/text';
import { useLinksViewState } from './view-state-provider';

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
    <AlertDialog open onOpenChange={(open) => !open && !deleting && closeDestroy()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
          <AlertDialogDescription>
            {what} will be removed from all your devices. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>
            <Text>Cancel</Text>
          </AlertDialogCancel>
          <Button variant="destructive" disabled={deleting} onPress={() => void onConfirm()}>
            <Text>{deleting ? 'Deleting…' : 'Delete permanently'}</Text>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
