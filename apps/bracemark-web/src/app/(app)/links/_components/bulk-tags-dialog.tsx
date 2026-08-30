'use client';

// The bulk tag editor behind the toolbar's "Edit tags": one TagsField over the
// whole selection. Seeded with the INTERSECTION of the selected links' tags —
// the tags every link carries — and saved as a DIFF against that seed: tags the
// user added are added to every link, seed tags the user removed are removed
// from every link, and a tag only SOME links carry is never shown and never
// touched — a bulk edit can't silently strip tags the user couldn't see. A
// selection whose links all share the same tags degenerates to plain
// edit-in-place. TagsField itself is unchanged (it's already a controlled set
// editor); the diff semantics live entirely in the save below.
//
// Hoisted to the page level and driven by view-state-provider's `retagging`,
// like LinkEditDialog: the selection's rows are virtualized, so the toolbar
// only *requests* the edit; while open it holds `engaged` so a background sync
// won't repaint the list under the modal. It upholds the editor invariants
// (docs/editors.md): draft copied from the seed at mount (closed = fully
// unmounted, so every open starts fresh; the dialog is modal, so it can't be
// retargeted while open), dirty means exactly "Save would write something",
// and the accidental close vectors are swallowed while dirty — Escape and the
// backdrop. The two DELIBERATE doors, Cancel and the corner X, bypass the guard
// (the X via DialogContent's `onClose`).

import { useState } from 'react';

import { type LinkView, useLinkMutations } from '@stxapps/web-react';
import { TagsField } from '@stxapps/web-ui/components/links/tags-field';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@stxapps/web-ui/components/ui/dialog';
import { Label } from '@stxapps/web-ui/components/ui/label';

import { useLinksViewState } from '../_contexts/view-state-provider';

export function BulkTagsDialog() {
  const { retagging, closeRetag } = useLinksViewState();
  if (!retagging) return null;
  return <BulkTagsForm links={retagging} onClose={closeRetag} />;
}

// Order-sensitive equality is fine here: the draft starts FROM the seed, so
// any reordering means the user removed and re-added — a real edit either way.
function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

function BulkTagsForm({ links, onClose }: { links: LinkView[]; onClose: () => void }) {
  const { exitBulkEdit } = useLinksViewState();
  const { updateMany } = useLinkMutations();

  // The seed: tags EVERY selected link carries, in the first link's order (a
  // stable, user-recognizable chip order). Snapshotted once at mount — draft
  // state, not a live binding (the copy-to-draft invariant).
  const [seed] = useState(() =>
    links[0].tagIds.filter((id) => links.every((l) => l.tagIds.includes(id))),
  );
  const [tagIds, setTagIds] = useState<string[]>(seed);
  const [saving, setSaving] = useState(false);

  const isDirty = !sameIds(tagIds, seed);

  const onSubmit = async (e: React.SubmitEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const added = tagIds.filter((id) => !seed.includes(id));
      const removed = new Set(seed.filter((id) => !tagIds.includes(id)));
      // Minimal per-link patch: a link already in the target state gets no write
      // (no updatedAt bump reordering the date-modified sort). This is the batch
      // whose patch genuinely differs row by row — "add these, remove those"
      // resolves against each link's own tagIds — which is why updateMany takes
      // per-link edits rather than one shared patch (mutations.ts, LinkEdit).
      const edits = links.flatMap((link) => {
        const kept = link.tagIds.filter((id) => !removed.has(id));
        const next = [...kept, ...added.filter((id) => !kept.includes(id))];
        return sameIds(next, link.tagIds) ? [] : [{ link, patch: { tagIds: next } }];
      });
      await updateMany(edits);
      onClose();
      exitBulkEdit();
    } finally {
      setSaving(false);
    }
  };

  return (
    // Guard only the ACCIDENTAL close vectors — a backdrop click and Escape are
    // the strays a dirty draft needs protecting from. The corner X is not one of
    // them: it is a control named Close, aimed at deliberately, so it takes
    // DialogContent's `onClose` below and discards the way Cancel does.
    <Dialog open onOpenChange={(open) => !open && !isDirty && onClose()}>
      {/* `flex flex-col` replaces the base `grid` (tailwind-merge drops it —
          both are `display` utilities), and it is load-bearing rather than a
          preference: a grid's `auto` rows are sized from their content and give
          none of it back when the container hits its max-height, so the cap
          would be honoured by spilling the footer off the bottom instead of by
          shrinking the chip area. The `min-h-0 shrink` chain from here down to
          that scroller is what carries the squeeze — `shrink`, not `flex-1`, at
          every step, so a two-chip dialog stays content-sized and only a full
          one gives way. link-edit-dialog.tsx is the same shape with `flex-1`,
          because its form is meant to fill. */}
      <DialogContent className="flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle>Edit tags</DialogTitle>
          <DialogDescription>
            Tags added here are added to all {links.length} selected{' '}
            {links.length === 1 ? 'link' : 'links'}; a removed tag is removed from all of them.
          </DialogDescription>
        </DialogHeader>
        {/* 24 / 16 / 6. The 24 is the step between the dialog's three REGIONS —
            header, body, footer — which is DialogContent's own gap; the `<form>`
            is plumbing (the submit button has to sit inside it), not a region,
            so it carries that same 24 and groups its body blocks in the wrapper
            below at 16, leaving 6 inside the field. The outer step has to beat
            the inner one or nothing reads as grouped — expo's DialogContent says
            the same, and at a uniform 16 the hint below became a peer of the
            BUTTONS rather than of its field. The `min-h-0 shrink` repeats on
            every level so the squeeze still reaches the chip scroller. */}
        <form className="flex min-h-0 shrink flex-col gap-6" onSubmit={onSubmit} noValidate>
          <div className="flex min-h-0 shrink flex-col gap-4">
            <div className="flex min-h-0 shrink flex-col gap-1.5">
              <Label htmlFor="bulk-tags" density="dense">
                Tags
              </Label>
              {/* TagsField sets no height of its own and its chip area grows with
                  the selection, so this is the one dialog body here that can
                  outgrow the viewport — and DialogContent's
                  `max-h-(--dialog-max-h)` caps the box without scrolling it (see
                  dialog.tsx for why the cap deliberately ships without an
                  `overflow-y-auto`). So the chip area owns the scroll: `max-h-60`
                  (~9 rows) is the PREFERRED height and `min-h-0 shrink` is what
                  lets even that give way on a short viewport, which is where the
                  whole box would otherwise overflow — a landscape phone leaves
                  ~316px for a dialog this one wants ~456 for. Exactly the pair
                  expo's port uses (`max-h-60 shrink`).

                  `-m-1 p-1` gives the chips' focus rings room the way the edit
                  dialog's body scroller does. The inline popover TagsField opens
                  is `fixed` and its containing block is DialogContent, not this
                  box, so nothing here clips it. */}
              <div className="-m-1 max-h-60 min-h-0 shrink overflow-y-auto p-1">
                <TagsField id="bulk-tags" value={tagIds} onChange={setTagIds} />
              </div>
            </div>
            {/* A peer block of the BODY, not a line in the field's column.
                lock-password-dialog draws the boundary: a message about the VALUE
                in the field belongs inside the column, one about the OPERATION
                gets its own block — and this is about the selection, not about the
                chips. It also fixes what the column got wrong optically. Inside,
                the group was bookended by 12px muted text at BOTH ends, so the
                region step above and the button row below had nothing but a
                hanging caption to push against; out here the group ends on the
                TagsField's own border (the same hard edge lock-password's input
                gives it), the 6 reads as the label's bond to its field, and the 16
                reads as separation from it. expo's port has the same two blocks in
                the same wrapper. */}
            <p className="text-xs text-muted-foreground">
              Only tags shared by every selected link are shown; a tag on just some of them is left
              untouched.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="default" size="sm" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
