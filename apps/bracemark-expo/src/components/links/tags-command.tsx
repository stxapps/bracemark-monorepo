import { useMemo, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Plus } from 'lucide-react-native';

import { useTags } from '@stxapps/expo-react';
import { flattenTree } from '@stxapps/shared';

import { cn } from '../../lib/utils';
import { Icon } from '../ui/icon';
import { Input } from '../ui/input';
import { Text } from '../ui/text';

// The searchable, multi-select tag picker body — the expo port of web-ui's
// TagsCommand (that header is canonical: multi-select, so a press toggles and
// the host stays open; the Create row mints through the caller's onCreate,
// i.e. useTagMutations.findOrCreate, so no duplicate is ever forked). Two hosts,
// the same split ListCommand has: TagsField's dialog (the link editors) and
// BulkTagsDialog, which renders this directly because it already IS a dialog
// holding nothing but the tag field. Query state lives here, so a host that
// unmounts on close resets the search for free.
//
// Chips where web has cmdk rows, and that is the one deliberate divergence: a
// wrapped cloud shows three or four tags per row where rows show one, and the
// share sheet's tags screen (share-tags-picker.tsx) copies this chip vocabulary
// exactly, so someone who tags in both places learns it once.
//
//  - The input filters the chips as you type and doubles as the new tag's name
//    field. `submitBehavior="submit"` keeps the keyboard up for the next entry,
//    which leaves this field no return-key exit — the scroller's `on-drag` and
//    `handled` are its dismissal paths (docs/soft-keyboard.md, _dismissal_).
//  - The Create chip is suppressed on an exact case-insensitive match, where
//    submit just selects (findOrCreate's reuse).
//  - A just-minted tag's chip surfaces a beat later, when the live useTags
//    query catches up — selected, since its id is already in `value`.
//
// THE CLOUD IS CAPPED, and that is the reason this body exists apart from its
// field. It used to render inline, every tag at once, with no bound: forty tags
// wrapped to eight rows and pushed the add panel's Note and Save off its
// keyboard-shortened height — the defect share-tags-picker.tsx records for the
// share sheet's compose screen.

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
  // Mint a tag by the typed name and add it. Awaited, so the Create chip can
  // disable itself while the write lands.
  onCreate: (name: string) => void | Promise<void>;
  // Onto the cloud's scroller — its cap. `max-h-80` matches ListCommand's list,
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
      <Input
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => void create()}
        submitBehavior="submit"
        placeholder="Search or create tags…"
        aria-label="Search or create tags"
        autoCapitalize="none"
        autoCorrect={false}
        className="h-9"
      />
      {/* `interactive` for list-command.tsx's reason: the host Dialog
          re-centres and this cloud regrows when the keyboard leaves, so
          `on-drag` jumped the chips under the finger. The input is
          `submitBehavior="submit"`, so return never blurs — the exits are
          DialogContent's chrome tap, `"handled"` here, and (iOS) a drag down
          into the keys. */}
      <ScrollView
        className={cn('max-h-80 shrink', className)}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {/* Only when there's nothing to pick AND nothing to create (blank query,
            no tags) — otherwise the Create chip is the next step. */}
        {visible.length === 0 && !canCreate && (
          <Text className="py-1.5 text-sm text-muted-foreground">No tags found.</Text>
        )}
        <View className="flex-row flex-wrap items-center gap-2">
          {visible.map((o) => {
            const selected = value.includes(o.id);
            return (
              <Pressable
                key={o.id}
                onPress={() => onToggle(o.id)}
                role="checkbox"
                aria-checked={selected}
                aria-label={o.name}
                className={cn('rounded-full px-3 py-1.5', selected ? 'bg-primary' : 'bg-muted')}
              >
                <Text
                  className={cn(
                    'text-sm',
                    selected ? 'text-primary-foreground' : 'text-muted-foreground',
                  )}
                >
                  {o.name}
                </Text>
              </Pressable>
            );
          })}
          {canCreate && (
            <Pressable
              role="button"
              disabled={creating}
              onPress={() => void create()}
              aria-label={`Create tag ${trimmed}`}
              className={cn(
                'flex-row items-center gap-1 rounded-full border border-dashed border-input px-3 py-1.5',
                creating && 'opacity-50',
              )}
            >
              <Icon as={Plus} className="size-3.5 text-muted-foreground" />
              <Text className="text-sm text-muted-foreground">Create “{trimmed}”</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
