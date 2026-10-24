// The confirmation behind Trash's "Delete permanently" — the expo port of
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
import { ScrollView } from 'react-native';

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
  const { destroyMany } = useLinkMutations();
  const [deleting, setDeleting] = useState(false);

  if (!destroying) return null;

  const onConfirm = async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      // One batched sweep for the whole selection, not a loop of `destroy` — see
      // useLinkMutations for why a loop is a repaint per link.
      await destroyMany(destroying);
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
        {/* The scroller AlertDialogContent's `max-h-full` needs, and the reason
            this file is the one alert dialog that has to have one: `what` above
            interpolates a link TITLE, which is unbounded, and RN text scales
            with the OS font setting while Uniwind's baked-rem padding does not.
            So this header — alone among the two rows here — can outgrow the
            window. `shrink` is what lets it give way, since RN children don't
            shrink by default and the cap alone would keep pushing the title off
            the TOP (the same cap/`shrink` pair bulk-tags-dialog.tsx and
            list-command.tsx use under the plain Dialog).

            It wraps the whole header rather than the description alone: the
            `gap-1.5` binding a title to its description lives INSIDE
            AlertDialogHeader, so splitting the two across the scroller boundary
            would re-space them at the content's `gap-6`. The title scrolling
            with its description is the right trade — it's one short line at the
            top, and what must never scroll away is the footer, which is outside
            this and stays pinned.

            `grow-0` IS THE OTHER HALF OF `shrink`, and it is not symmetry: a
            `ScrollView` ships `flexGrow: 1` in its own base style
            (react-native's `ScrollView.js`, `styles.baseVertical`), which no
            Uniwind class here cancels — `shrink` sets `flexShrink` and leaves
            the grow behind. Under this content box that grow claims every point
            the cap offers, so a two-line confirmation rendered FULL HEIGHT with
            the footer pinned at the bottom of the screen and a screenful of
            empty popover between it and the description. Measured on the iOS
            simulator, both ways, with the dialog open under fast refresh; also
            measured: dropping `max-h-full` does NOT help, so it is the grow and
            never the cap. Nothing catches it — the box has no overflow, no
            clipping and no error, it is merely the wrong size, and jest renders
            no layout at all (docs/soft-keyboard.md, _the traps_). Any scroller
            put directly under Alert/DialogContent wants both classes. */}
        <ScrollView className="shrink grow-0" nestedScrollEnabled>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              {what} will be removed from all your devices. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
        </ScrollView>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>
            <Text>Cancel</Text>
          </AlertDialogCancel>
          <Button
            variant="destructive"
            testID="link-destroy-submit"
            disabled={deleting}
            onPress={() => void onConfirm()}
          >
            <Text>{deleting ? 'Deleting…' : 'Delete permanently'}</Text>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
