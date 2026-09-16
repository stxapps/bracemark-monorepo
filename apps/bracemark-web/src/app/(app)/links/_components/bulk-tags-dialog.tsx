'use client';

// The bulk tag editor behind the toolbar's "Edit tags": one TagsCommand over the
// whole selection. Seeded with the INTERSECTION of the selected links' tags —
// the tags every link carries — and saved as a DIFF against that seed: tags the
// user added are added to every link, seed tags the user removed are removed
// from every link, and a tag only SOME links carry never starts selected and is
// never touched — a bulk edit can't silently strip tags the user couldn't see.
// A selection whose links all share the same tags degenerates to plain
// edit-in-place. It renders the picker body directly because this dialog has no
// other field to disclose; adding a TagsField trigger and a nested popover would
// add one tap and one floating layer to the dialog's only job. The diff semantics
// live entirely in the save below.
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

import { type LinkView, useLinkMutations, useTagMutations } from '@stxapps/web-react';
import { TagsCommand } from '@stxapps/web-ui/components/links/tags-command';
import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@stxapps/web-ui/components/ui/dialog';

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
  const { findOrCreate } = useTagMutations();

  // The seed: tags EVERY selected link carries, in the first link's order (a
  // stable, user-recognizable chip order). Snapshotted once at mount — draft
  // state, not a live binding (the copy-to-draft invariant).
  const [seed] = useState(() =>
    links[0].tagIds.filter((id) => links.every((l) => l.tagIds.includes(id))),
  );
  const [tagIds, setTagIds] = useState<string[]>(seed);
  const [saving, setSaving] = useState(false);

  const isDirty = !sameIds(tagIds, seed);

  const toggle = (tagId: string) => {
    setTagIds((ids) => (ids.includes(tagId) ? ids.filter((id) => id !== tagId) : [...ids, tagId]));
  };
  const create = async (name: string) => {
    const tag = await findOrCreate(name);
    if (tag) setTagIds((ids) => (ids.includes(tag.id) ? ids : [...ids, tag.id]));
  };

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
            {/* The dialog's only field is already open: TagsCommand owns the
                search/create input and its capped scroller. `min-h-0 shrink`
                carries DialogContent's height squeeze down to that list without
                making a short taxonomy fill the dialog.

                `-mx-2` cancels the 8px the picker sits inside this dialog's text
                column: `Command`'s own `p-1` (it is styled to BE a popover, which
                here it isn't — the dialog already is one) plus the 4 that
                CommandInput's wrapper and CommandList's `px-1` add on top of it.
                What that lands on the column is the search field's BORDER BOX and
                the row highlight's rect — which is where a field belongs
                (link-edit-dialog's inputs are flush on it) and what expo's port of
                this dialog already draws, its bare Input and row press rects both
                at the column edge. Not the row TEXT, which stays 12 further in
                (CommandItem's `px-3`); pulling THAT to the column would hang the
                highlight and its focus ring 12px out into a 24px gutter, i.e. a
                full-bleed menu, which this isn't. Horizontal only, so `p-1`'s 4px
                above and below stay — the gaps the block comments here derive are
                measured with them.

                `w-auto` is load-bearing beside it, not tidying. `Command`'s base
                is `size-full`, and a flex item with a definite `width: 100%` does
                not grow into a negative margin — it SHIFTS: measured, the box
                lands 8px outside the column on the left and 8px INSIDE it on the
                right, 16px of asymmetry. With the width back to `auto` the stretch
                resolves as the line minus margins and both edges move out by 8.
                tailwind-merge keeps `size-full` AND `w-auto` (they aren't a
                conflict pair — it only drops `w-*`/`h-*` that a LATER `size-*`
                overrides), so this rides on Tailwind emitting `size-*` before
                `w-*`/`h-*` and the later rule winning — the same mechanism the
                `h-auto` beside it already depends on for the height squeeze. */}
            <TagsCommand
              value={tagIds}
              onToggle={toggle}
              onCreate={create}
              className="-mx-2 h-auto min-h-0 w-auto shrink"
            />
            {/* A peer block of the BODY, not a line in the field's column.
                lock-password-dialog draws the boundary: a message about the VALUE
                in the field belongs inside the column, one about the OPERATION
                gets its own block — and this is about the selection, not about the
                chips. It also fixes what the column got wrong optically. Inside,
                the group was bookended by 12px muted text at BOTH ends, so the
                region step above and the button row below had nothing but a
                hanging caption to push against; out here the command's list ends
                before the 16 reads as separation from it. expo's port has the same
                two blocks in the same wrapper. */}
            <p className="text-xs text-muted-foreground">
              Only tags shared by every selected link start selected; a tag on just some of them is
              left untouched.
            </p>
          </div>
          {/* A row at every width, not DialogFooter's stacked phone default —
              an editor's footer (docs/editors.md, _the editing surfaces_). */}
          <DialogFooter className="flex-row justify-end">
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
