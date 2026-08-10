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
// and the accidental close vectors are swallowed while dirty (the explicit
// Cancel bypasses the guard).

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
  const { update } = useLinkMutations();

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
      for (const link of links) {
        const kept = link.tagIds.filter((id) => !removed.has(id));
        const next = [...kept, ...added.filter((id) => !kept.includes(id))];
        // Minimal per-link patch: a link already in the target state gets no
        // write (no updatedAt bump reordering the date-modified sort).
        if (!sameIds(next, link.tagIds)) await update(link, { tagIds: next });
      }
      onClose();
      exitBulkEdit();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !isDirty && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit tags</DialogTitle>
          <DialogDescription>
            Tags added here are added to all {links.length} selected{' '}
            {links.length === 1 ? 'link' : 'links'}; a removed tag is removed from all of them.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bulk-tags">Tags</Label>
            <TagsField id="bulk-tags" value={tagIds} onChange={setTagIds} />
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
