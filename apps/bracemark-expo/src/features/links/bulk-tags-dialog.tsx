// The bulk tag editor behind the bar's "Edit tags" — the expo port of
// bracemark-web's BulkTagsDialog (`(app)/links/_components/bulk-tags-dialog.tsx`,
// the canonical doc for the diff semantics: seeded with the INTERSECTION of
// the selected links' tags, saved as a DIFF against that seed — added tags are
// added to every link, removed seed tags removed from every link, and a tag
// only SOME links carry is never shown as selected and never touched, so a
// bulk edit can't silently strip tags the user couldn't see). Like web, the
// field is one TagsField over the whole selection — the same native cousin the
// add/edit screens render (components/links/tags-field), so bulk retag gets
// its filter input and reuse-or-mint Create for free; the diff semantics live
// entirely in the save below. Hoisted to the
// screen level and driven by view-state-provider's `retagging`, like the
// destroy confirm; while open it holds `engaged` so a background sync won't
// repaint the list under the modal. The editor invariants (docs/editors.md)
// hold: draft copied from the seed at mount (closed = fully unmounted, so
// every open starts fresh), dirty means exactly "Save would write something",
// and the accidental close vectors (overlay press, the ✕) are swallowed while
// dirty — the explicit Cancel bypasses the guard.

import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { type LinkView, useLinkMutations } from '@stxapps/expo-react';

import { TagsField } from '../../components/links/tags-field';
import { Button } from '../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Text } from '../../components/ui/text';
import { useLinksViewState } from './view-state-provider';

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

  const onSave = async () => {
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
    <Dialog open onOpenChange={(open) => !open && !isDirty && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit tags</DialogTitle>
          <DialogDescription>
            Tags added here are added to all {links.length} selected{' '}
            {links.length === 1 ? 'link' : 'links'}; a removed tag is removed from all of them.
          </DialogDescription>
        </DialogHeader>
        {/* The chip area can outgrow a dialog (unlike the edit screens' own
            scrolling form), so the field sits in a capped scroll; taps must
            land while the filter keyboard is still up. A tag minted here
            persists even if the user then cancels — web's accepted
            mint-then-cancel cost — and lands selected in the draft, so the
            dirty guard engages. `shrink` is what lets the 240 give way when the
            keyboard leaves less than the whole form needs — this is the tallest
            dialog in the app (~520 of the ~566pt an iPhone 17 Pro leaves), so it
            is the one that would otherwise lose its title off the top rather
            than scroll. */}
        {/* Field and caption are ONE block, at the 16 below the dialog's own
            24 — the caption is about the selection, so it belongs to the field
            rather than standing beside the header and footer as a third
            top-level block, which is what it did when all three steps were the
            same 24 (see DialogContent's gap note for why the outer step has to
            beat the inner one). Web reaches the same shape through the `<form>`
            its submit button needs; this wrapper is what stands in for it here.

            The wrapper MUST carry `shrink`: RN children don't shrink by default
            (link-destroy-confirm.tsx says the same), so an unwrapped one would
            hold its content height and the squeeze below would never reach the
            ScrollView — the cap would push the title off the TOP instead, on
            the one dialog where that actually bites. */}
        <View className="flex shrink flex-col gap-4">
          <ScrollView
            className="max-h-60 shrink"
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
          >
            <TagsField value={tagIds} onChange={setTagIds} />
          </ScrollView>
          <Text className="text-xs text-muted-foreground">
            Only tags shared by every selected link start selected; a tag on just some of them is
            left untouched.
          </Text>
        </View>
        <DialogFooter>
          <Button variant="ghost" size="sm" onPress={onClose}>
            <Text>Cancel</Text>
          </Button>
          <Button size="sm" disabled={saving} onPress={() => void onSave()}>
            <Text>{saving ? 'Saving…' : 'Save'}</Text>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
