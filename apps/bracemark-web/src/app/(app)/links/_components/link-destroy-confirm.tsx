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
      {/* `flex flex-col` overrides the base `grid`, and it is what makes the
          scroller below WORK rather than a stylistic preference. A grid's `auto`
          rows are sized from their content and do not give any of it back when
          the container hits a max-height — measured in Chrome: the rows keep
          their full height and the box simply overflows, so the cap changes
          nothing and the footer still lands off-screen. Flex items shrink by
          default, and a child with `overflow` other than `visible` has its
          automatic minimum size resolved to 0, so the scroller absorbs the
          squeeze. (tailwind-merge drops the base `grid` for us — both are
          `display` utilities. link-edit-dialog.tsx overrides the same way.) */}
      <AlertDialogContent className="flex flex-col">
        {/* The scroller AlertDialogContent's `max-h-(--dialog-max-h)` needs, and
            the reason this file is the one alert dialog that has to have one:
            `what` above interpolates a link TITLE, which is unbounded. So this
            header is the only part of the box that can outgrow the viewport, and
            a cap with nothing to scroll would spill it past both viewport edges
            rather than reveal it (the cap deliberately ships without an
            `overflow-y-auto` of its own — see dialog.tsx for why it can't).
            `shrink` is the default in CSS and spelled out only to say that this
            row is the one meant to give way; `min-h-0` states the automatic
            minimum the `overflow-y-auto` already implies. Never the footer,
            which stays outside this and pinned. The expo port is the same shape
            (features/links/link-destroy-confirm.tsx), where `shrink` is load-
            bearing rather than decorative — RN children don't shrink by default.

            It wraps the whole header rather than the description alone: the gap
            binding a title to its description lives INSIDE AlertDialogHeader, so
            splitting the two across the scroller boundary would re-space them at
            the content's `gap-6`. */}
        <div className="min-h-0 shrink overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              {what} will be removed from all your devices. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
        </div>
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
