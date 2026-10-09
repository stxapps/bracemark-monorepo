import { useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { useTags } from '@stxapps/expo-react';
import { flattenTree } from '@stxapps/shared';

import { cn } from '../../lib/utils';
import { Input } from '../ui/input';
import { TagPickerRows } from './tag-picker-rows';

// The searchable, multi-select tag picker body — the expo port of web-ui's
// TagsCommand (that header is canonical: multi-select, so a press toggles and
// the host stays open; the Create row mints through the caller's onCreate,
// i.e. useTagMutations.findOrCreate, so no duplicate is ever forked). Two hosts,
// the same split ListCommand has: TagsField's dialog (the link editors) and
// BulkTagsDialog, which renders this directly because it already IS a dialog
// holding nothing but the tag field. Query state lives here, so a host that
// unmounts on close resets the search for free.
//
// Full-width checkbox rows, matching the list picker's scanning and touch
// geometry while keeping the semantic difference: tags are a set, so a press
// toggles one and the host stays open. The share sheet renders these same rows
// from its snapshot through tag-picker-rows.tsx.
//
//  - The input filters the rows as you type and doubles as the new tag's name
//    field. `submitBehavior="submit"` keeps the keyboard up for the next entry,
//    which leaves this field no return-key exit — the host's chrome tap and
//    the scroller's `handled` are its dismissal paths (docs/soft-keyboard.md,
//    _dismissal_).
//  - The Create row is suppressed on an exact case-insensitive match, where
//    submit just selects (findOrCreate's reuse).
//  - A just-minted tag's row surfaces a beat later, when the live useTags
//    query catches up — selected, since its id is already in `value`.
//
// THE LIST IS CAPPED, and that is the reason this body exists apart from its
// field. It used to render inline, every tag at once, with no bound and pushed
// the add panel's Note and Save off its keyboard-shortened height — the defect
// share-tags-picker.tsx records for the share sheet's compose screen.

export function TagsCommand({
  value,
  onToggle,
  onCreate,
  className,
}: {
  // Chosen tag ids — their chips render selected.
  value: string[];
  // Toggle a tag's membership. Multi-select: the host stays open.
  onToggle: (tagId: string) => void;
  // Mint a tag by the typed name and add it. Awaited, so the Create row can
  // disable itself while the write lands.
  onCreate: (name: string) => void | Promise<void>;
  // Onto the rows' scroller — its cap. `max-h-80` matches ListCommand's list,
  // so the two picker dialogs open at the same height; a host that has less room
  // to give passes a smaller one (BulkTagsDialog).
  className?: string;
}) {
  const tags = useTags();
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  // Flat (tag association ignores depth), plain names — web's rows, verbatim.
  const options = useMemo(
    () => flattenTree(tags).map((n) => ({ id: n.item.id, name: n.item.name })),
    [tags],
  );

  const trimmed = query.trim();
  const q = trimmed.toLowerCase();
  const visible = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  const canCreate = trimmed !== '' && !options.some((o) => o.name.toLowerCase() === q);

  const create = async () => {
    if (creating || trimmed === '') return;
    setCreating(true);
    try {
      await onCreate(trimmed);
      setQuery('');
    } finally {
      setCreating(false);
    }
  };

  return (
    // `shrink` on the wrapper AND the scroller: the host dialog is bounded by
    // what the keyboard leaves (dialog.tsx's `max-h-full`), and RN children
    // don't shrink by default — without both, the cloud keeps its cap and
    // pushes the dialog's title off the top of a short phone instead of
    // scrolling (list-command.tsx says the same).
    <View className="shrink gap-2">
      {/* The `tag-picker-*` ids are fixed rather than props: every host mounts
          one picker at a time (docs/e2e.md, _the testID contract_). */}
      <Input
        testID="tag-picker-search"
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => void create()}
        submitBehavior="submit"
        placeholder="Search or create tags…"
        aria-label="Search or create tags"
        className="h-9"
      />
      {/* `interactive` for list-command.tsx's reason: the host Dialog
          re-centres and this list regrows when the keyboard leaves, so
          `on-drag` jumped the rows under the finger. The input is
          `submitBehavior="submit"`, so return never blurs — the exits are
          DialogContent's chrome tap, `"handled"` here, and (iOS) a drag down
          into the keys. */}
      <ScrollView
        testID="tag-picker-rows"
        className={cn('max-h-80 shrink', className)}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <TagPickerRows
          rows={visible.map((option) => ({ ...option, selected: value.includes(option.id) }))}
          onToggle={onToggle}
          emptyText="No tags found."
          createName={canCreate ? trimmed : undefined}
          creating={creating}
          onCreate={canCreate ? () => void create() : undefined}
          createTestID="tag-picker-create"
        />
      </ScrollView>
    </View>
  );
}
